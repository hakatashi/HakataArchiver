
// eslint-disable-next-line no-unused-vars
import type {APIGatewayProxyEvent, APIGatewayProxyResult} from 'aws-lambda';
import 'source-map-support/register.js';
import get from 'lodash/get';

export const verifyRequest = (event: APIGatewayProxyEvent): APIGatewayProxyResult => {
	const origin = get(event, ['headers', 'origin'], '');
	if (!origin.match(/^https?:\/\/(?:localhost:\d+|archive\.hakatashi\.com)$/)) {
		return {
			statusCode: 403,
			headers: {
				'Content-Type': 'application/json',
				Vary: 'Origin',
				'Access-Control-Allow-Origin': origin,
			},
			body: JSON.stringify({
				message: 'origin not allowed',
			}),
		};
	}

	if (get(event, ['queryStringParameters', 'apikey']) !== process.env.HAKATASHI_API_KEY) {
		return {
			statusCode: 403,
			headers: {
				'Content-Type': 'application/json',
				Vary: 'Origin',
				'Access-Control-Allow-Origin': origin,
			},
			body: JSON.stringify({
				message: 'apikey is missing or wrong',
			}),
		};
	}

	return null;
};
