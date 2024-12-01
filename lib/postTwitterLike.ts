import type {APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register.js';
import crawlTweet from '../crawlers/twitter';

export const handler: APIGatewayProxyHandler = async (event) => {
	const body = JSON.parse(event.body);

	if (typeof body.apikey !== 'string' || body.apikey !== process.env.HAKATASHI_API_KEY) {
		return {
			statusCode: 403,
			body: 'apikey is missing or wrong',
		};
	}

	const url = body.url;

	if (typeof url !== 'string') {
		return {
			statusCode: 400,
			body: 'url is missing',
		};
	}

	try {
		await crawlTweet(url);
	} catch (error) {
		console.error(error);
		return {
			statusCode: 500,
			body: error.toString(),
		};
	}

	return {
		statusCode: 200,
		body: 'ok',
	};
};

export default handler;
