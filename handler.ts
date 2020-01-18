/* eslint-disable import/prefer-default-export */

import {APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register.js';

export const hello: APIGatewayProxyHandler = async (event, _context) => ({
	statusCode: 200,
	body: JSON.stringify({
		message: 'Go Serverless Webpack (Typescript) v1.0! Your function executed successfully!',
		input: event,
	}, null, 2),
});
