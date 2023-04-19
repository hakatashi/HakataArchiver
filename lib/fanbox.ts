import {inspect} from 'util';
// eslint-disable-next-line no-unused-vars
import type {APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult} from 'aws-lambda';
import 'source-map-support/register.js';
import get from 'lodash/get';
import {db} from './aws';

interface StringSet {
	values: string[],
}

interface CreatorsItem {
	creatorId: string,
	postIds?: StringSet,
	savedPostIds?: StringSet,
}

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

export const getFanboxPost = async (postId: string) => {
	const {Item: post} = await db.get({
		TableName: 'hakataarchive-entries-fanbox',
		Key: {
			id: postId,
		},
	}).promise();

	const images = [
		...post.body?.images ?? [],
		...Object.values(post.body?.imageMap ?? {}),
	];

	const mediaContents = await Promise.all(images.map(async (image) => {
		const filename = path.posix.basename(image.originalUrl);
		const id = path.parse(filename).name;
		const key = `fanbox/${filename}`;
		const head = await s3.headObject({
			Bucket: 'hakataarchive',
			Key: key,
		}).promise();
		return {
			...head,
			key,
			id,
			originalUrl: image.originalUrl,
		};
	}));

	const imageInfos = mediaContents.map((item) => {
		const url = s3.getSignedUrl('getObject', {
			Bucket: 'hakataarchive',
			Key: item.key,
		});
		return {
			src: url,
			id: item.id,
			originalUrl: item.originalUrl,
			w: parseInt(item.Metadata.width),
			h: parseInt(item.Metadata.height),
		};
	});

	const files = [
		...post.body?.files ?? [],
		...Object.values(post.body?.fileMap ?? {}),
	];

	const fileInfos = files.map((file) => {
		const filename = path.posix.basename(file.url);
		const id = path.parse(filename).name;
		const url = s3.getSignedUrl('getObject', {
			Bucket: 'hakataarchive',
			Key: `fanbox/${filename}`,
		});
		return {
			url,
			id,
			originalUrl: file.url,
		};
	});

	return {
		post,
		images: imageInfos,
		files: fileInfos,
	};
};

export const listCreators: APIGatewayProxyHandler = async (event) => {
	const error = verifyRequest(event);

	if (error !== null) {
		return error;
	}

	// Retrieve all existing ids of database
	let lastKey = null;
	const creatorIds: string[] = [];
	while (lastKey !== undefined) {
		const existingEntries = await db.scan({
			TableName: 'hakataarchive-entries-fanbox-creators',
			ProjectionExpression: 'creatorId',
			ReturnConsumedCapacity: 'INDEXES',
			...(lastKey === null ? {} : {ExclusiveStartKey: lastKey}),
		}).promise();

		const items = existingEntries.Items as CreatorsItem[];
		console.log(`[fanbox] Retrieved ${items.length} existing entries (ExclusiveStartKey = ${inspect(lastKey)})`);
		console.log(`[fanbox] Consumed capacity: ${inspect(existingEntries.ConsumedCapacity)}`);

		lastKey = existingEntries.LastEvaluatedKey;

		for (const item of items) {
			creatorIds.push(item.creatorId);
		}
	}

	const origin = get(event, ['headers', 'origin'], '');

	return {
		statusCode: 200,
		headers: {
			'Content-Type': 'application/json',
			Vary: 'Origin',
			'Access-Control-Allow-Origin': origin,
		},
		body: JSON.stringify({
			creatorIds,
		}),
	};
};

export const getCreatorPosts: APIGatewayProxyHandler = async (event) => {
	const error = verifyRequest(event);

	if (error !== null) {
		return error;
	}

	const creatorId = get(event, ['queryStringParameters', 'creatorId']);
	if (typeof creatorId !== 'string') {
		return error;
	}

	const {Item: entry} = await db.get({
		TableName: 'hakataarchive-entries-fanbox-creators',
		Key: {
			creatorId,
		},
	}).promise();

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
		}),
	};
};

export const getPost: APIGatewayProxyHandler = async (event) => {
	const error = verifyRequest(event);

	if (error !== null) {
		return error;
	}

	const postId = get(event, ['queryStringParameters', 'postId']);
	if (typeof postId !== 'string') {
		return error;
	}

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
