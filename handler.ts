/* eslint-disable import/prefer-default-export */

// eslint-disable-next-line no-unused-vars
import {APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register.js';
import {DynamoDB} from 'aws-sdk';
import axios from 'axios';

const db = new DynamoDB.DocumentClient();

const PER_PAGE = 48;

export const crawlPixiv: APIGatewayProxyHandler = async (event) => {
	const body = JSON.parse(event.body);

	if (typeof body.apikey !== 'string' || body.apikey !== process.env.HAKATASHI_API_KEY) {
		return {
			statusCode: 403,
			body: 'apikey is missing or wrong',
		};
	}

	const sessionData = await db.get({
		TableName: 'hakataarchive-sessions',
		Key: {
			id: 'pixiv',
		},
	}).promise();
	const {session} = sessionData.Item;

	for (const visibility of ['show', 'hide']) {
		const offset = 0;

		const {data} = await axios.get('https://www.pixiv.net/ajax/user/1817093/illusts/bookmarks', {
			params: {
				tag: '',
				offset,
				limit: PER_PAGE,
				rest: visibility,
			},
			headers: {
				Cookie: `PHPSESSID=${session}`,
			},
		});

		if (data.error) {
			console.error(data.message);
			continue;
		}

		const {works} = data.body;
	}

	return {
		statusCode: 200,
		body: 'ok',
	};
};

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
