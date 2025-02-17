import { InstanceBase, runEntrypoint, InstanceStatus } from '@companion-module/base'
import got from 'got'
import { HttpProxyAgent, HttpsProxyAgent } from 'hpagent'
import { configFields } from './config.js'
import { upgradeScripts } from './upgrade.js'
import { FIELDS } from './fields.js'
import JimpRaw from 'jimp'

// Webpack makes a mess..
const Jimp = JimpRaw.default || JimpRaw

const OnOffToggle = {
    ON: 'on',
    OFF: 'off',
    TOGGLE: 'toggle',
}

class CastrAPIInstance extends InstanceBase {

    streams = new Map()
    streamsByName = new Map()
    variableDefinitionsCache = null
    actionsCache = null
    platforms = []
    platformsDropdown = []

    configUpdated(config) {
        this.config = config

        this.initAPI()
        this.initActions()
        this.initFeedbacks()
        this.log('debug', 'Config updated')
    }

    /**
     * Returns promise of an API call, taking care of authorization and error handling
     * 
     * @param {String} method 
     * @param {String} endpoint 
     * @param {String} pathParams 
     * @param {Object} bodyParams 
     * @returns {Promise}
     */

    callAPI(method, endpoint, pathParams, bodyParams) {
        const authorization = Buffer.from(this.config.accessToken + ':' + this.config.secretKey).toString('base64')
        let url = this.config.apiUrl + endpoint
        if (pathParams) {
            url = url + '/' + pathParams
        }
        let options = {
            method: method,
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                authorization: `Basic ${authorization}`,
            },
        }
        if (bodyParams) {
            options.body = JSON.stringify(bodyParams)
        }
        this.log('debug', `Calling ${method} ${url} with options: ` + JSON.stringify(options))
        return new Promise((resolve, reject) => {
            fetch(url, options)
                .then((res) => {
                    if (!res.ok) {
                        switch (res.status) {
                            case 401:
                                this.updateStatus(InstanceStatus.AuthenticationFailure, res.statusText)
                                this.log('error', `API Authorization failed: ${res.status} ${res.statusText}`)
                                break
                            default:
                                this.updateStatus(InstanceStatus.UnknownError, res.statusText)
                                this.log('error', `API Error: ${res.status} ${res.statusText}`)
                                break
                        }
                        reject(res.statusText)
                    } else {
                        this.log('debug', `API Response: ${res.status} ${res.statusText}`)
                    }
                    resolve(res.json())
                })
                .catch((err) => {
                    reject(err)
                })
        })
    }

    /**
     * Polls the API for the list of live streams, updates all variables, actions and feedbacks
     */
    pollAPI() {
        this.callAPI('GET', 'live_streams', null, null)
            .then((json) => {
                this.log('debug', 'pollAPI() live_streams response: ' + JSON.stringify(json, null, 2))

                this.streams.clear()
                this.streamsByName.clear()
                this.platforms = []
                this.platformsDropdown = []
                let variableDefinitions = []
                let variableValues = {}

                function addVar(id, name, value) {
                    id = id.replace(/[^a-zA-Z0-9_-]/g, '_'); // sanitize the id
                    variableDefinitions.push({ variableId: id, name: name });
                    variableValues[id] = value;
                }

                for (const stream of json.docs) {
                    this.streams.set(stream._id, stream)
                    this.streamsByName.set(stream.name, stream)
                    try {
                        addVar(`stream_${stream._id}_name`, `Stream '${stream._id}' Name`, stream.name)
                        addVar(`stream_${stream._id}_enabled`, `Stream '${stream._id}' Enabled`, stream.enabled || false)
                        addVar(`stream_${stream._id}_status`, `Stream '${stream._id}' Status`, stream.broadcasting_status || 'undefined')
                        addVar(`stream_${stream._id}_ingest_server`, `Stream '${stream._id}' ingest server`, stream.ingest.server || '')
                        addVar(`stream_${stream._id}_ingest_key`, `Stream '${stream._id}' ingest key`, stream.ingest.key || '')
                        addVar(`stream_${stream.name}_id`, `Stream '${stream.name}' ID`, stream._id)
                        addVar(`stream_${stream.name}_enabled`, `Stream '${stream.name}' Enabled`, stream.enabled || false)
                        addVar(`stream_${stream.name}_status`, `Stream '${stream.name}' Status`, stream.broadcasting_status || 'undefined')
                        addVar(`stream_${stream.name}_ingest_server`, `Stream '${stream.name}' ingest server`, stream.ingest.server || '')
                        addVar(`stream_${stream.name}_ingest_key`, `Stream '${stream.name}' ingest key`, stream.ingest.key || '')
                        if (typeof stream.platforms === 'object' && Array.isArray(stream.platforms)) {
                            for (const platform of stream.platforms) {
                                addVar(`stream_${stream.name}_platform_${platform.name}_status`, `Stream '${stream.name}', platform '${platform.name}' status`, platform.broadcasting_status || 'undefined')
                                addVar(`stream_${stream.name}_platform_${platform.name}_enabled`, `Stream '${stream.name}', platform '${platform.name}' enabled`, platform.enabled || false)
                                let platformId = `${stream.name} :: ${platform.name}`
                                this.platformsDropdown.push({ id: platformId, label: platformId })
                                this.platforms[platformId] = { stream: stream._id, platform: platform._id }
                            }
                        }
                    }
                    catch (err) {
                        this.log('error', `failed to parse stream data: ${err}`)
                    }
                }

                this.initActions()

                // Update variable definitions (skip if cahced definitions are the same) and values
                if (JSON.stringify(variableDefinitions) !== JSON.stringify(this.variableDefinitionsCache)) {
                    this.setVariableDefinitions(variableDefinitions)
                    this.variableDefinitionsCache = variableDefinitions
                    this.log('debug', 'variable definitions updated')
                }
                this.setVariableValues(variableValues)

                this.updateStatus(InstanceStatus.Ok)

            })
            .catch((err) => this.log('error', 'failed to read stream list'))
    }

    pollTimer = null;

    initAPI() {

        this.pollAPI()

        // start polling timer
        if (this.pollTimer) {
            clearInterval(this.pollTimer)
        }
        if (this.config.pollInterval > 0) {
            this.pollTimer = setInterval(() => {
                this.log('debug', 'polling timer fired')
                this.pollAPI()
            }, this.config.pollInterval * 1000)
        }
    }

    init(config) {
        this.config = config

        this.updateStatus(InstanceStatus.Unknown, 'Initializing')
        this.initAPI()
        this.initActions()
        this.initFeedbacks()
    }

    // Return config fields for web config
    getConfigFields() {
        return configFields
    }

    // When module gets deleted
    async destroy() {

        if (this.pollTimer) {
            clearInterval(this.pollTimer)
        }

        // Stop any running feedback timers
        for (const timer of Object.values(this.feedbackTimers)) {
            clearInterval(timer)
        }
    }

    /**
     * Resolves the "stream" and "platform" parameters, expanding the variables and trying to translate
     * from stream name to stream id and from platform name to platform id.
     * 
     * @param {import('@companion-module/base').CompanionActionEvent} action
     * @param {import('@companion-module/base/dist/module-api/common.js').CompanionCommonCallbackContext} context
     */
    async resolveActionOptions(action, context) {
        if (action.options.stream) {
            action.options.stream = await context.parseVariablesInString(action.options.stream);
            if (this.streams.has(action.options.stream)) {
            } else
                if (this.streamsByName.has(action.options.stream)) {
                    action.options.stream = this.streamsByName.get(action.options.stream)._id
                }
                else {
                    this.log('warn', `Stream name '${action.options.stream}' not found, passing as-is to API`)
                }
        }
        this.log('debug', "resolveActionOptions() - resolved action: " + JSON.stringify(action, null, 2))
    }

    /**
     * Enables or disables a stream
     * 
     * @param {import('@companion-module/base').CompanionActionEvent} action
     * @param {import('@companion-module/base/dist/module-api/common.js').CompanionCommonCallbackContext} context
     */
    async actionEnableStream(action, context) {
        this.log('debug', "actionEnableStream() - action: " + JSON.stringify(action, null, 2))
        await this.resolveActionOptions(action, context)
        let enabled = false;
        switch (action.options.onoff) {
            case OnOffToggle.ON: enabled = true; break;
            case OnOffToggle.OFF: enabled = false; break;
            case OnOffToggle.TOGGLE:
                if (this.streams.has(action.options.stream)) {
                    enabled = !this.streams.get(action.options.stream).enabled
                }
                else {
                    this.log('error', `actionEnableStream(): Stream '${action.options.stream}' not found, cannot toggle`)
                }
                break;
        }
        this.callAPI('PATCH', 'live_streams', action.options.stream, { enabled: enabled })
            .then((json) => {
                this.log('debug', 'live_streams PATCH response: ' + JSON.stringify(json, null, 2))
                //this.getStreams()
            })
            .catch((err) => this.log('error', 'failed to enable stream'))
    }

    initActions() {
        this.log('debug', 'Initializing actions')

        let streamField = {
            type: 'dropdown',
            label: 'Stream',
            allowCustom: true,
            id: 'stream',
            useVariables: true,
            choices:
                Array.from(this.streams.keys())
                    .map((k) => { return { id: this.streams.get(k).name, label: this.streams.get(k).name } })
                    .concat(
                        Array.from(this.streams.keys())
                            .map((k) => { return { id: k, label: k } })
                    ),
            tooltip: 'use either the stream name or the stream id, variables are expanded',
        }

        let platformField = {
            type: 'dropdown',
            label: 'Platform',
            allowCustom: true,
            id: 'platform',
            useVariables: true,
            choices: this.platformsDropdown,
            tooltip: 'select or type in stream / platform, variables are expanded',
        }


        let onOffToggleField = {
            type: 'dropdown',
            label: 'On / Off / Toggle',
            id: 'onoff',
            choices: Object.keys(OnOffToggle).map((k) => { return { id: OnOffToggle[k], label: OnOffToggle[k] } }),
        }

        let newActions = {
            enableStream: {
                name: 'Enable Stream',
                label: 'Enable Stream',
                options: [
                    streamField,
                    onOffToggleField
                ],
                callback: (action, context) => this.actionEnableStream(action, context),
            },
            enablePlatform: {
                name: 'Enable Platform',
                label: 'Enable Platform',
                options: [
                    platformField,
                    onOffToggleField
                ],
                callback: (action, context) => this.actionEnableStream(action, context),
            }
        }

        if (JSON.stringify(newActions) !== JSON.stringify(this.actionsCache)) {
            this.setActionDefinitions(newActions)
            this.actionsCache = newActions
            this.log('debug', 'action definitions updated')
        }
    }

    feedbackTimers = {}

    initFeedbacks() {
        const urlLabel = this.config.prefix ? 'URI' : 'URL'

        this.setFeedbackDefinitions({
            imageFromUrl: {
                type: 'advanced',
                name: 'Image from URL',
                options: [FIELDS.Url(urlLabel), FIELDS.Header, FIELDS.PollInterval],
                subscribe: (feedback) => {
                    // Ensure existing timer is cleared
                    if (this.feedbackTimers[feedback.id]) {
                        clearInterval(this.feedbackTimers[feedback.id])
                        delete this.feedbackTimers[feedback.id]
                    }

                    // Start new timer if needed
                    if (feedback.options.interval) {
                        this.feedbackTimers[feedback.id] = setInterval(() => {
                            this.checkFeedbacksById(feedback.id)
                        }, feedback.options.interval)
                    }
                },
                unsubscribe: (feedback) => {
                    // Ensure timer is cleared
                    if (this.feedbackTimers[feedback.id]) {
                        clearInterval(this.feedbackTimers[feedback.id])
                        delete this.feedbackTimers[feedback.id]
                    }
                },
                callback: async (feedback, context) => {
                    try {
                        const { url, options } = await this.prepareQuery(context, feedback, false)

                        const res = await got.get(url, options)

                        // Scale image to a sensible size
                        const img = await Jimp.read(res.rawBody)
                        const png64 = await img
                            .scaleToFit(feedback.image?.width ?? 72, feedback.image?.height ?? 72)
                            .getBase64Async('image/png')

                        return {
                            png64,
                        }
                    } catch (e) {
                        // Image failed to load so log it and output nothing
                        this.log('error', `Failed to fetch image: ${e}`)
                        return {}
                    }
                },
            },
        })
    }
}

runEntrypoint(CastrAPIInstance, upgradeScripts)
