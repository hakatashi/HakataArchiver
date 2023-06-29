import type {APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register.js';
import {db} from './aws';

export const handler: APIGatewayProxyHandler = async (event) => {
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

export default handler;
