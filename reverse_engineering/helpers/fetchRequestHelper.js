'use strict'
const fetch = require('node-fetch');
const { dependencies } = require('../appDependencies');
const { getClusterData } = require('./scalaScriptGeneratorHelper');
const { getCount, prepareNamesForInsertionIntoScalaCode } = require('./utils');
let activeContexts = {};

const destroyActiveContext = () => {
	if (activeContexts.scala) {
		destroyContext(activeContexts.scala.connectionInfo, activeContexts.scala.id);
	}
	if (activeContexts.sql) {
		destroyContext(activeContexts.sql.connectionInfo, activeContexts.sql.id);
	}

	activeContexts = {};
};

const fetchApplyToInstance = async (connectionInfo, logger) => {
	const scriptWithoutNewLineSymb = connectionInfo.script.replaceAll(/[\s]+/g, " ");
	const eachEntityScript = scriptWithoutNewLineSymb.split(';').filter(script => script !== '');
	const progress = (message) => {
		logger.log('info', message, 'Applying to instande');
		logger.progress(message);
	};
	for (let script of eachEntityScript) {
		progress({ message: `Applying script: \n ${script}` });
		const command = `var stmt = sqlContext.sql("${script}")`;
		await Promise.race([executeCommand(connectionInfo, command), new Promise((_r, rej) => setTimeout(() => { throw new Error("Timeout exceeded for script\n" + script); }, connectionInfo.applyToInstanceQueryRequestTimeout || 120000))])
	}
};

const fetchDocuments = async ({ connectionInfo, dbName, tableName, fields, recordSamplingSettings }) => {
	try {
		const countResult = await executeCommand(connectionInfo, `SELECT COUNT(*) FROM \`${dbName}\`.\`${tableName}\``, 'sql');
		const count = dependencies.lodash.get(countResult, '[0][0]', 0);

		if (count === 0) {
			return [];
		}

		const columnsToSelect = fields.map(field => field.name);
		const columnsToSelectString = columnsToSelect.map(fieldName => `\`${fieldName}\``).join(', ');
		const limit = getCount(count, recordSamplingSettings);

		const documentsResult = await executeCommand(connectionInfo, `SELECT ${columnsToSelectString} FROM \`${dbName}\`.\`${tableName}\` LIMIT ${limit}`, 'sql');
		return documentsResult.map(result =>
			columnsToSelect.reduce((document, colName, index) => (
				{
					...document,
					[colName]: result[index]
				}
			), {})
		);
	} catch (e) {
		return [];
	}
};

const fetchClusterProperties = async (connectionInfo) => {
	const query = connectionInfo.host + `/api/2.0/clusters/get?cluster_id=${connectionInfo.clusterId}`;
	const options = getRequestOptions(connectionInfo)
	return await fetch(query, options)
		.then(response => {
			if (response.ok) {
				return response.text()
			}
			throw {
				message: response.statusText, code: response.status, description: ''
			};
		})
		.then(body => {
			try {
				return JSON.parse(body);
			} catch (e) {
				throw {
					message: e.message, code: "", description: 'body: ' + body
				};
			}
		})
};

const fetchClusterDatabasesNames = async (connectionInfo) => {
	const result = await executeCommand(connectionInfo, "SHOW DATABASES", 'sql');
	return dependencies.lodash.flattenDeep(result);
};

const fetchDatabaseViewsNames = (dbName, connectionInfo) => executeCommand(connectionInfo, `SHOW VIEWS IN \`${dbName}\``, 'sql');

const fetchClusterTablesNames = (dbName, connectionInfo) => executeCommand(connectionInfo, `SHOW TABLES IN \`${dbName}\``, 'sql');

const fetchClusterData = async (connectionInfo, collectionsNames, databasesNames, logger) => {
	const databasesPropertiesResult = await Promise.all(databasesNames.map(async dbName => {
		logger.log('info', '', `Start describe database: ${dbName} `);
		const dbInfoResult = await executeCommand(connectionInfo, `DESCRIBE DATABASE EXTENDED \`${dbName}\``, 'sql');
		logger.log('info', '', `Database: ${dbName} successfully described`);
		const dbProperties = dbInfoResult.reduce((dbProperties, row) => {
			if (row[0] === 'Location') {
				return { ...dbProperties, "location": row[1] }
			}
			if (row[0] === 'Comment') {
				return { ...dbProperties, "description": row[1] }
			}
			if (row[0] === 'Properties') {
				return { ...dbProperties, "dbProperties": row[1] }
			}
			return dbProperties;
		}, {});
		return { dbName, dbProperties }
	}));

	const databasesProperties = databasesPropertiesResult.reduce((properties, { dbName, dbProperties }) => ({ ...properties, [dbName]: dbProperties }), {})

	const { tableNames, dbNames } = prepareNamesForInsertionIntoScalaCode(databasesNames, collectionsNames);
	const getClusterDataCommand = getClusterData(tableNames.join(', '), dbNames.join(', '));
	logger.log('info', '', `Start retrieving tables info: \nDatabases: ${dbNames.join(', ')} \nTables: ${tableNames.join(', ')}`);
	const databasesTablesInfoResult = await executeCommand(connectionInfo, getClusterDataCommand);
	logger.log('info', '', `Finish retrieving tables info: \nDatabases: ${dbNames.join(', ')} \nTables: ${tableNames.join(', ')}`);
	const formattedResult = databasesTablesInfoResult.split('clusterData: String =')[1]
		.replaceAll('\n', ' ')
		.replaceAll('\\n', '')
		.replaceAll('"{', '{')
		.replaceAll('"[', '[')
		.replaceAll('}"', '}')
		.replaceAll('\\"', '"')
		.replaceAll(']"', ']');
	try {
		const databasesTablesInfo = JSON.parse(formattedResult);
		return databasesNames.reduce((clusterData, dbName) => ({
			...clusterData,
			[dbName]: {
				dbTables: dependencies.lodash.get(databasesTablesInfo, dbName, {}),
				dbProperties: dependencies.lodash.get(databasesProperties, dbName, {})
			}
		}), {})
	} catch (error) {
		logger.log('error', { error }, `\nDatabricks response: ${databasesTablesInfoResult}\n\nFormatted result: ${formattedResult}\n`);
		throw error;
	}
};

const fetchCreateStatementRequest = async (entityName, connectionInfo) => {
	const result = await executeCommand(connectionInfo, `SHOW CREATE TABLE ${entityName};`, 'sql');
	return dependencies.lodash.get(result, '[0][0]', '')
};

const getRequestOptions = (connectionInfo) => {
	const headers = {
		'Authorization': 'Bearer ' + connectionInfo.accessToken
	};

	return {
		'method': 'GET',
		'headers': headers
	};
};

const postRequestOptions = (connectionInfo, body) => {
	const headers = {
		'Content-Type': 'application/json',
		'Authorization': 'Bearer ' + connectionInfo.accessToken
	};

	return {
		'method': 'POST',
		headers,
		body
	}
};

const createContext = (connectionInfo, language) => {
	if (activeContexts[language]) {
		return Promise.resolve(activeContexts[language].id);
	}
	const query = connectionInfo.host + '/api/1.2/contexts/create';
	const body = JSON.stringify({
		"language": language,
		"clusterId": connectionInfo.clusterId
	})
	const options = postRequestOptions(connectionInfo, body);

	return fetch(query, options)
		.then(async response => {
			if (response.ok) {
				return response.text()
			}
			const description = await response.json();
			throw {
				message: `${response.statusText}\n${JSON.stringify(description)}`, code: response.status, description
			};
		})
		.then(body => {
			body = JSON.parse(body);
			activeContexts[language] = {
				id: body.id,
				connectionInfo
			}
			return activeContexts[language].id;
		})
};

const destroyContext = (connectionInfo, contextId) => {
	const query = connectionInfo.host + '/api/1.2/contexts/destroy'
	const body = JSON.stringify({
		"contextId": contextId,
		"clusterId": connectionInfo.clusterId
	});
	const options = postRequestOptions(connectionInfo, body);
	return fetch(query, options)
		.then(response => {
			if (response.ok) {
				return response.text()
			}
			throw {
				message: response.statusText, code: response.status, description: body
			};
		})
		.then(body => {
			body = JSON.parse(body);
		});
};

const executeCommand = (connectionInfo, command, language = "scala") => {

	let activeContextId;

	return createContext(connectionInfo, language)
		.then(contextId => {
			activeContextId = contextId;
			const query = connectionInfo.host + '/api/1.2/commands/execute';
			const body = JSON.stringify({
				language,
				clusterId: connectionInfo.clusterId,
				contextId,
				command
			});
			const options = postRequestOptions(connectionInfo, body)

			return fetch(query, options)
				.then(response => {
					if (response.ok) {
						return response.text()
					}
					throw {
						message: response.statusText, code: response.status, description: body
					};
				})
				.then(body => {

					body = JSON.parse(body);

					const query = new URL(connectionInfo.host + '/api/1.2/commands/status');
					const params = {
						clusterId: connectionInfo.clusterId,
						contextId: activeContextId,
						commandId: body.id
					}
					query.search = new URLSearchParams(params).toString();
					const options = getRequestOptions(connectionInfo);
					return getCommandExecutionResult(query, options);
				})
		}
		)
};

const getCommandExecutionResult = (query, options) => {
	return fetch(query, options)
		.then(response => {
			if (response.ok) {
				return response.text()
			}
			throw {
				message: response.statusText, code: response.status, description: body
			};
		})
		.then(body => {
			body = JSON.parse(body);
			if (body.status === 'Finished' && body.results !== null) {
				if (body.results.resultType === 'error') {
					throw {
						message: body.results.data || body.results.cause, code: "", description: ""
					};
				}
				return body.results.data;
			}

			if (body.status === 'Error') {
				throw {
					message: "Error during receiving command result", code: "", description: ""
				};
			}
			return getCommandExecutionResult(query, options);
		})
};

module.exports = {
	fetchClusterProperties,
	fetchApplyToInstance,
	fetchDocuments,
	destroyActiveContext,
	fetchClusterData,
	fetchCreateStatementRequest,
	fetchClusterDatabasesNames,
	fetchDatabaseViewsNames,
	fetchClusterTablesNames
};