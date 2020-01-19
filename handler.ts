/* eslint-disable import/prefer-default-export */

// eslint-disable-next-line no-unused-vars
import {APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register.js';
import {DynamoDB} from 'aws-sdk';

const db = new DynamoDB.DocumentClient();

export const postSession: APIGatewayProxyHandler = async (event) => {
	const body = JSON.parse(event.body);

	if (typeof body.apikey !== 'string' || body.apikey !== process.env.HAKATASHI_API_KEY) {
		return {
			statusCode: 403,
			body: 'apikey is missing or wrong',
		};
	}

	await db.put({
		TableName: 'hakataarchive-sessions',
		Item: {
			id: body.id,
			session: body.session,
		},
	}).promise();

	return {
		statusCode: 200,
		body: 'ok',
	};
};
