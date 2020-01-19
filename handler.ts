/* eslint-disable import/prefer-default-export */

// eslint-disable-next-line no-unused-vars
import {APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register.js';
import {DynamoDB} from 'aws-sdk';

const db = new DynamoDB.DocumentClient();

export const postSession: APIGatewayProxyHandler = async (event) => {
	const data = await db.get({
		TableName: 'hakataarchive-sessions',
		Key: {
			id: 'pixiv',
		},
	}).promise();

	return {
		statusCode: 200,
		body: JSON.stringify({
			message: 'Pohe!',
			input: event,
			data: data.Item,
		}, null, 2),
	};
};
