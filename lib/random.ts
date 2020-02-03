import {basename} from 'path';
// eslint-disable-next-line no-unused-vars
import {APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register.js';
import get from 'lodash/get';
import sample from 'lodash/sample';
import {db, s3} from './aws';

export const twitter: APIGatewayProxyHandler = async (event) => {
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

	const result = await s3.getObject({
		Bucket: 'hakataarchive',
		Key: 'index/twitter.json',
	}).promise();
	const entryIds = JSON.parse(result.Body.toString());
	const entryId = sample(entryIds);

	const {Item: entry} = await db.get({
		TableName: 'hakataarchive-entries-twitter',
		Key: {
			id_str: '746483745276858368',
		},
	}).promise();
	const media = get(entry, ['extended_entities', 'media'], []).map((medium) => {
		const filename = basename(medium.media_url_https);
		return s3.getSignedUrl('getObject', {
			Bucket: 'hakataarchive',
			Key: `twitter/${filename}`,
		});
	});

	return {
		statusCode: 200,
		headers: {
			'Content-Type': 'application/json',
			Vary: 'Origin',
			'Access-Control-Allow-Origin': origin,
		},
		body: JSON.stringify({
			entry,
			media,
		}),
	};
};

export const pixiv: APIGatewayProxyHandler = () => {};
