import { InstanceBase, runEntrypoint, InstanceStatus, combineRgb } from '@companion-module/base'
import _ from 'lodash'
import { configFields } from './config.js'
import { upgradeScripts } from './upgrade.js'
import Buffer from 'node:buffer'

const COLOR = {
	bgRed: combineRgb(204, 0, 0),
	white: combineRgb(255, 255, 255),
	bgGreen: combineRgb(0, 204, 0),
}

const OnOffToggle = {
	ON: 'enable',
	OFF: 'disable',
	TOGGLE: 'toggle',
}

class CastrAPIInstance extends InstanceBase {
	streams = new Map()
	streamsByName = new Map()
	variableDefinitionsCache = null
	variableValuesCache = null
	statusCache = null
	actionsCache = null
	feedbacksCache = null
	platforms = []
	platformsDropdown = []

	configUpdated(config) {
		this.config = config
		this.initAPI()
		this.initActions()
		this.initFeedbacks()
		this.log('debug', 'Config updated')
	}

	updateStatusCached(status, message) {
		if (status !== this.statusCache) {
			this.updateStatus(status, message)
			this.statusCache = status
		}
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
								this.updateStatusCached(InstanceStatus.AuthenticationFailure, res.statusText)
								this.log('error', `API Authorization failed: ${res.status} ${res.statusText}`)
								break
							default:
								this.updateStatusCached(InstanceStatus.UnknownError, res.statusText)
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
					id = id.replace(/[^a-zA-Z0-9_-]/g, '_') // sanitize the id
					variableDefinitions.push({ variableId: id, name: name })
					variableValues[id] = value
				}

				for (const stream of json.docs) {
					this.streams.set(stream._id, stream)
					this.streamsByName.set(stream.name, stream)
					try {
						addVar(`stream_${stream._id}_name`, `Stream '${stream._id}' Name`, stream.name)
						addVar(`stream_${stream._id}_enabled`, `Stream '${stream._id}' Enabled`, stream.enabled || false)
						addVar(
							`stream_${stream._id}_status`,
							`Stream '${stream._id}' Status`,
							stream.broadcasting_status || 'undefined',
						)
						// values: 'online', 'offline'
						addVar(
							`stream_${stream._id}_ingest_server`,
							`Stream '${stream._id}' ingest server`,
							stream.ingest.server || '',
						)
						addVar(`stream_${stream._id}_ingest_key`, `Stream '${stream._id}' ingest key`, stream.ingest.key || '')
						addVar(`stream_${stream.name}_id`, `Stream '${stream.name}' ID`, stream._id)
						addVar(`stream_${stream.name}_enabled`, `Stream '${stream.name}' Enabled`, stream.enabled || false)
						addVar(
							`stream_${stream.name}_status`,
							`Stream '${stream.name}' Status`,
							stream.broadcasting_status || 'undefined',
						)
						addVar(
							`stream_${stream.name}_ingest_server`,
							`Stream '${stream.name}' ingest server`,
							stream.ingest.server || '',
						)
						addVar(`stream_${stream.name}_ingest_key`, `Stream '${stream.name}' ingest key`, stream.ingest.key || '')
						this.platformsDropdown.push({ id: `${stream.name} :: *ALL*`, label: `${stream.name} :: *ALL*` })
						if (typeof stream.platforms === 'object' && Array.isArray(stream.platforms)) {
							for (const platform of stream.platforms) {
								addVar(
									`stream_${stream.name}_platform_${platform.name}_status`,
									`Stream '${stream.name}', platform '${platform.name}' status`,
									platform.broadcasting_status || 'undefined',
								)
								addVar(
									`stream_${stream.name}_platform_${platform.name}_enabled`,
									`Stream '${stream.name}', platform '${platform.name}' enabled`,
									platform.enabled || false,
								)
								let platformId = `${stream.name} :: ${platform.name}`
								this.platformsDropdown.push({ id: platformId, label: platformId })
								this.platforms[platformId] = { stream: stream._id, platform: platform._id }
							}
						}
						this.platformsDropdown.sort((a, b) => a.id.localeCompare(b.id)) // sort alphabetically by id
					} catch (err) {
						this.log('error', `failed to parse stream data: ${err}`)
					}
				}

				// Update variable definitions (skip if cahced definitions are the same)
				if (!_.isEqual(variableDefinitions, this.variableDefinitionsCache)) {
					this.setVariableDefinitions(variableDefinitions)
					this.variableDefinitionsCache = variableDefinitions
					this.log('debug', 'variable definitions updated')
				}
				// Update variable values (skip if cached values ara the same)
				if (!_.isEqual(variableValues, this.variableValuesCache)) {
					this.setVariableValues(variableValues)
					this.variableValuesCache = variableValues
					this.log('debug', 'variable values updated')
					this.initActions()
					this.initFeedbacks()
					this.checkFeedbacks('streamEnabled', 'platformsEnabled')
				}

				this.updateStatusCached(InstanceStatus.Ok)
			})
			.catch((err) => this.log('error', 'failed to read stream list: '+err))
	}

	pollTimer = null
	startPollTimer() {
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

	initAPI() {
		this.pollAPI()
		this.startPollTimer()
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
	}

	/**
	 * Resolves the "stream" and "platform" parameters, expanding the variables and trying to translate
	 * from stream name to stream id and from platform name to platform id.
	 *
	 * @param {import('@companion-module/base').CompanionActionEvent} action
	 * @param {import('@companion-module/base/dist/module-api/common.js').CompanionCommonCallbackContext} context
	 */
	async resolveOptions(action, context) {
		let returnValue = true

		// resolve stream field
		if (typeof action.options.stream !== 'undefined') {
			action.options.stream = await context.parseVariablesInString(action.options.stream)
			if (this.streams.has(action.options.stream)) {
                // do nothing, already resolved
			} else if (this.streamsByName.has(action.options.stream)) {
				action.options.stream = this.streamsByName.get(action.options.stream)._id
			} else {
				returnValue = false
				this.log('warn', `Stream name '${action.options.stream}' not found, passing as-is`)
			}
		}

		// resolve platform field and build platforms list
		if (typeof action.options.platform !== 'undefined') {
			action.options.platform = await context.parseVariablesInString(action.options.platform)
			let [streamName, platformName] = action.options.platform.split(' :: ')
			if (this.streamsByName.has(streamName)) {
				let stream = this.streamsByName.get(streamName)
				action.options.stream = stream._id
				action.options.platforms = []
				if (typeof stream.platforms === 'object' && Array.isArray(stream.platforms)) {
					for (const platform of stream.platforms) {
						if (platform.name === platformName || platformName === '*ALL*') {
							action.options.platforms.push({ id: platform._id, enabled: platform.enabled })
						}
					}
				}
			} else {
				returnValue = false
				this.log('error', `resolveOptions() - platform '${streamName}' not found`)
			}
		}
		this.log('debug', `resolveOptions(): ${returnValue}, resolved: ` + JSON.stringify(action, null, 2))
		return returnValue
	}

	/**
	 * Enables or disables a stream
	 *
	 * @param {import('@companion-module/base').CompanionActionEvent} action
	 * @param {import('@companion-module/base/dist/module-api/common.js').CompanionCommonCallbackContext} context
	 */
	async actionEnableStream(action, context) {
		this.log('debug', 'actionEnableStream() - action: ' + JSON.stringify(action, null, 2))
		await this.resolveOptions(action, context)
		let enabled = false
		switch (action.options.onoff) {
			case OnOffToggle.ON:
				enabled = true
				break
			case OnOffToggle.OFF:
				enabled = false
				break
			case OnOffToggle.TOGGLE:
				if (this.streams.has(action.options.stream)) {
					enabled = !this.streams.get(action.options.stream).enabled
				} else {
					this.log('error', `actionEnableStream(): Stream '${action.options.stream}' not found, cannot toggle`)
				}
				break
		}
		this.callAPI('PATCH', 'live_streams', action.options.stream, { enabled: enabled })
			.then((json) => {
				this.log('debug', 'live_streams PATCH response: ' + JSON.stringify(json, null, 2))
				this.pollAPI()
			})
			.catch((err) => this.log('error', 'failed to enable stream: ' + err))
	}

	/**
	 * Enables or disables a target platform
	 *
	 * @param {import('@companion-module/base').CompanionActionEvent} action
	 * @param {import('@companion-module/base/dist/module-api/common.js').CompanionCommonCallbackContext} context
	 */
	async actionEnablePlatform(action, context) {
		this.log('debug', 'actionEnablePlatform() - action: ' + JSON.stringify(action, null, 2))
		await this.resolveOptions(action, context)

		for (const platform of action.options.platforms) {
			let enabled = false
			switch (action.options.onoff) {
				case OnOffToggle.ON:
					enabled = true
					break
				case OnOffToggle.OFF:
					enabled = false
					break
				case OnOffToggle.TOGGLE:
					enabled = !platform.enabled
					break
			}
			this.callAPI('PATCH', 'live_streams', `${action.options.stream}/platforms/${platform.id}`, { enabled: enabled })
				.then((json) => {
					this.log('debug', 'platforms PATCH response: ' + JSON.stringify(json, null, 2))
					this.pollAPI()
				})
				.catch((err) => this.log('error', 'failed to enable platform: ' + err))
		}
	}

	formFields() {
		return {
			stream: {
				type: 'dropdown',
				label: 'Stream',
				allowCustom: true,
				id: 'stream',
				useVariables: true,
				choices: Array.from(this.streams.keys())
					.map((k) => {
						return { id: this.streams.get(k).name, label: this.streams.get(k).name }
					})
					.concat(
						Array.from(this.streams.keys()).map((k) => {
							return { id: k, label: k }
						}),
					),
				tooltip: 'use either the stream name or the stream id, variables are expanded',
			},
			platform: {
				type: 'dropdown',
				label: 'Platform',
				allowCustom: true,
				id: 'platform',
				useVariables: true,
				choices: this.platformsDropdown,
				tooltip: 'select or type in stream / platform, variables are expanded',
			},
			onOffToggle: {
				type: 'dropdown',
				label: 'Action',
				id: 'onoff',
				choices: Object.keys(OnOffToggle).map((k) => {
					return { id: OnOffToggle[k], label: OnOffToggle[k] }
				}),
				tooltip: 'select if you want to enable, disable or toggle',
			},
		}
	}

	initActions() {
		this.log('debug', 'Initializing actions')

		let FIELDS = this.formFields()

		let newActions = {
			enableStream: {
				name: 'Enable Stream',
				label: 'Enable Stream',
				options: [FIELDS.stream, FIELDS.onOffToggle],
				callback: (action, context) => this.actionEnableStream(action, context),
			},
			enablePlatform: {
				name: 'Enable Platform',
				label: 'Enable Platform',
				options: [FIELDS.platform, FIELDS.onOffToggle],
				callback: (action, context) => this.actionEnablePlatform(action, context),
			},
		}

		if (!_.isEqual(newActions, this.actionsCache)) {
			this.setActionDefinitions(newActions)
			this.actionsCache = newActions
			this.log('debug', 'action definitions updated')
		}
	}

	initFeedbacks() {

		let FIELDS = this.formFields()
		let feedbacks = {}

		feedbacks.streamEnabled = {
			type: 'boolean',
			name: 'Stream Enabled',
			description: 'Indicate if the stream is enabled',
			showInvert: true,

			options: [FIELDS.stream],
			defaultStyle: {
				bgcolor: COLOR.bgRed,
				color: COLOR.white,
			},
			callback: async (feedback, context) => {
				if (this.streams.size > 0 && (await this.resolveOptions(feedback, context))) {
					return this.streams.get(feedback.options.stream).enabled
				} else {
					return false
				}
			},
		}

		feedbacks.platformsEnabled = {
			type: 'boolean',
			name: 'Platform Enabled',
			description: 'Indicate if a platform is enabled',
			showInvert: true,

			options: [FIELDS.platform],
			defaultStyle: {
				bgcolor: COLOR.bgRed,
				color: COLOR.white,
			},
			callback: async (feedback, context) => {
				if (Object.keys(this.platforms).length && (await this.resolveOptions(feedback, context))) {
					// note: Object.keys([]).length is the way to tell the array this.platforms is not empty.
					// the only way that works. JavaScript is fucked up.
					let allEnabled = true
					for (const platform of feedback.options.platforms) {
						if (!platform.enabled) allEnabled = false
					}
					return allEnabled
				} else {
					return false
				}
			},
		}

		if (!_.isEqual(feedbacks, this.feedbacksCache)) {
			this.setFeedbackDefinitions(feedbacks)
			this.feedbacksCache = feedbacks
			this.log('debug', 'feedback definitions updated')
		}
	}
}

runEntrypoint(CastrAPIInstance, upgradeScripts)
