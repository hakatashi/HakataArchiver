/* global BigInt */

import path from 'path';
import {inspect} from 'util';
// eslint-disable-next-line no-unused-vars
import type {APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register.js';
import type {DynamoDB} from 'aws-sdk';
import {sampleSize} from 'lodash';
import get from 'lodash/get';
import sample from 'lodash/sample';
import {db, s3} from './aws';
import {getFanboxPost} from './fanbox';
import {verifyRequest} from './util';

interface StringSet {
	values: string[],
}

interface CreatorsItem {
	creatorId: string,
	postIds?: StringSet,
	savedPostIds?: StringSet,
}

// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function () {
	return this.toString();
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
		const filename = path.posix.basename(medium.media_url_https);
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

	let visibility = 'public';
	if (get(event, ['queryStringParameters', 'visibility']) === 'private') {
		visibility = 'private';
	}

	let count = parseInt(get(event, ['queryStringParameters', 'count'], ''));
	if (Number.isNaN(count) || count > 100 || count < 1) {
		count = 1;
	}

	const result = await s3.getObject({
		Bucket: 'hakataarchive',
		Key: 'index/pixiv.json',
	}).promise();
	const entryIds = JSON.parse(result.Body.toString());
	const sampledEntryIds = sampleSize(entryIds[visibility], count);

	const {Responses: responses} = await db.batchGet({
		RequestItems: {
			'hakataarchive-entries-pixiv': {
				Keys: sampledEntryIds.map((entryId) => ({
					illustId: entryId,
				})),
			},
		},
	}).promise();

	const entries = get(responses, 'hakataarchive-entries-pixiv', [] as DynamoDB.DocumentClient.ItemList);

	const photoItemsList = await Promise.all(sampledEntryIds.map(async (entryId) => {
		const items = await s3.listObjectsV2({
			Bucket: 'hakataarchive',
			Prefix: `pixiv/${entryId}_`,
		}).promise();
		return items.Contents || [];
	}));

	const photoItems = photoItemsList.flat();

	const sortedContents = await Promise.all(photoItems.sort((a, b) => (
		parseInt(a.Key.split('_p')[1]) - parseInt(b.Key.split('_p')[1])
	)).map(async (content) => {
		const head = await s3.headObject({
			Bucket: 'hakataarchive',
			Key: content.Key,
		}).promise();
		return {...head, Key: content.Key};
	}));

	const media = sortedContents.map((item) => {
		const url = s3.getSignedUrl('getObject', {
			Bucket: 'hakataarchive',
			Key: item.Key,
		});
		return {
			src: url,
			w: parseInt(item.Metadata.width),
			h: parseInt(item.Metadata.height),
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
			entry: entries[0],
			entries,
			media,
		}),
	};
};

export const fanbox: APIGatewayProxyHandler = async (event) => {
	const error = verifyRequest(event);

	if (error !== null) {
		return error;
	}

	// Retrieve all existing ids of database
	let lastKey = null;
	const postIds: string[] = [];
	while (lastKey !== undefined) {
		const existingEntries = await db.scan({
			TableName: 'hakataarchive-entries-fanbox-creators',
			ProjectionExpression: 'savedPostIds',
			ReturnConsumedCapacity: 'INDEXES',
			...(lastKey === null ? {} : {ExclusiveStartKey: lastKey}),
		}).promise();

		const items = existingEntries.Items as CreatorsItem[];
		console.log(`[fanbox] Retrieved ${items.length} existing entries (ExclusiveStartKey = ${inspect(lastKey)})`);
		console.log(`[fanbox] Consumed capacity: ${inspect(existingEntries.ConsumedCapacity)}`);

		lastKey = existingEntries.LastEvaluatedKey;

		for (const item of items) {
			postIds.push(...(item.savedPostIds?.values ?? []));
		}
	}

	const postId = sample(postIds);
	const origin = get(event, ['headers', 'origin'], '');

	return {
		statusCode: 200,
		headers: {
			'Content-Type': 'application/json',
			Vary: 'Origin',
			'Access-Control-Allow-Origin': origin,
		},
		body: JSON.stringify(await getFanboxPost(postId)),
	};
};
