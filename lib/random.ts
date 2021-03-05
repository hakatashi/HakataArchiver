/* global BigInt */

import {basename} from 'path';
// eslint-disable-next-line no-unused-vars
import type {APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult} from 'aws-lambda';
import 'source-map-support/register.js';
import get from 'lodash/get';
import range from 'lodash/range';
import sample from 'lodash/sample';
import {db, s3} from './aws';

// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function () {
	return this.toString();
};

const verifyRequest = (event: APIGatewayProxyEvent): APIGatewayProxyResult => {
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

export const twitter: APIGatewayProxyHandler = async (event) => {
	const error = verifyRequest(event);

	if (error !== null) {
		return error;
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
			id_str: entryId,
		},
	}).promise();
	const media = get(entry, ['extended_entities', 'media'], []).map((medium) => {
		const filename = basename(medium.media_url_https);
		const url = s3.getSignedUrl('getObject', {
			Bucket: 'hakataarchive',
			Key: `twitter/${filename}`,
		});
		return {
			src: url,
			w: get(medium, ['sizes', 'large', 'w'], null),
			h: get(medium, ['sizes', 'large', 'h'], null),
		};
	});

	const origin = get(event, ['headers', 'origin'], '');

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

export const pixiv: APIGatewayProxyHandler = async (event) => {
	const error = verifyRequest(event);

	if (error !== null) {
		return error;
	}

	const result = await s3.getObject({
		Bucket: 'hakataarchive',
		Key: 'index/pixiv.json',
	}).promise();
	const entryIds = JSON.parse(result.Body.toString());
	const entryId = sample(entryIds);

	const {Item: entry} = await db.get({
		TableName: 'hakataarchive-entries-pixiv',
		Key: {
			illustId: entryId,
		},
	}).promise();

	const photoItems = await s3.listObjectsV2({
		Bucket: 'hakataarchive',
		Prefix: `pixiv/${entryId}_`,
	}).promise();

	const media = photoItems.Contents.map((item) => {
		const url = s3.getSignedUrl('getObject', {
			Bucket: 'hakataarchive',
			Key: item.Key,
		});
		return {
			src: url,
		};
	});

	const origin = get(event, ['headers', 'origin'], '');

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
