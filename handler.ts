/* eslint-disable import/prefer-default-export */

import {APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register.js';

export const postSession: APIGatewayProxyHandler = async (event, _context) => ({
	statusCode: 200,
	body: JSON.stringify({
		message: 'Yay!',
		input: event,
	}, null, 2),
});
