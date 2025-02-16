export const configFields = [
	{
		type: 'static-text',
		id: 'apikeys',
		width: 12,
		labela: 'castr.io API Keys',
		value: `
			<hr />
			<h5>castr.io API Keys</h5>
			<p>Please login into your castr.io account, and obtain an <b>Access Token</b>. This can be done in <b>Settings / API</b> by 
			clicking &quot;Create API Token&quot button.</p>
		`,
	},
	{
		type: 'textinput',
		id: 'accessToken',
		label: 'Access Token ID',
		width: 12,
		default: '',
	},
	{
		type: 'textinput',
		id: 'secretKey',
		label: 'Secret Key',
		width: 12,
		default: '',
	},
	{
		type: 'static-text',
		id: 'miscsettings',
		width: 12,
		labela: 'Options',
		value: `
			<hr />
			<h5>Options</h5>
			<p>Leave these as default unless you know what you are doing.</p>
		`,
	},
	{
		type: 'number',
		id: 'pollInterval',
		label: 'Polling Interval',
		tooltip: 'how often to poll the API for new data, in seconds. 0=never',
		width: 12,
		default: 10,
		min: 0,
		max: 3600,
	},
	{
		type: 'textinput',
		id: 'apiUrl',
		label: 'Base API URL',
		width: 12,
		default: 'https://api.castr.com/v2/',
		tooltip: 'Leave blank to use the default API URL',
	},
	{
		type: 'static-text',
		id: 'hbar',
		width: 12,
		labela: 'Options',
		value: `
			<hr />
		`,
	},
]
