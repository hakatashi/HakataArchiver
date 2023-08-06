/* eslint-disable func-style */
/* eslint-disable require-jsdoc */
import {writeFile} from 'fs/promises';
import {inspect} from 'util';
import axios from 'axios';
import {db} from '../lib/aws';

const urlRegex = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9(@:%_\+.~#?&\/=]*)/g;

const wait = (time: number) => new Promise((resolve) => {
	setTimeout(resolve, time);
});

interface File {
	url: string,
}

interface Image {
	originalUrl: string,
	thumbnailUrl: string,
}

interface Item {
	body: {
		images?: Image[],
		imageMap?: {
			[imageId: string]: Image,
		},
		files?: File[],
		fileMap?: {
			[fileId: string]: File,
		},
		urlEmbedMap?: {
			[id: string]: {
				id: string,
				html?: string,
				type: string,
			},
		},
		text?: string,
		blocks?: {
			type: string,
			text?: string,
			urlEmbedId?: string,
		}[],
	} | null,
	excerpt: string,
	id: string,
	isRestricted: boolean,
	creatorId: string,
}

const main = async () => {
	// Retrieve all entries of database
	let lastKey = null;
	while (lastKey !== undefined) {
		const urls = new Set<string>();

		await wait(5000);
		const existingEntries = await db.scan({
			TableName: 'hakataarchive-entries-fanbox',
			ProjectionExpression: 'id,body,excerpt',
			...(lastKey === null ? {} : {ExclusiveStartKey: lastKey}),
		}).promise();

		const items = existingEntries.Items as Item[];
		console.log(`[fanbox] Retrieved ${items.length} existing entries (ExclusiveStartKey = ${inspect(lastKey)})`);

		lastKey = existingEntries.LastEvaluatedKey;

		for (const item of items) {
			console.log(`[fanbox] Processing item ${item.id}`);
			if (item.excerpt) {
				for (const [url] of item.excerpt.matchAll(urlRegex)) {
					console.log(`[fanbox] Found URL in excerpt: ${url}`);
					urls.add(url);
				}
			}
			if (item.body) {
				if (item.body.text) {
					for (const [url] of item.body.text.matchAll(urlRegex)) {
						console.log(`[fanbox] Found URL in text: ${url}`);
						urls.add(url);
					}
				}
				if (item.body.blocks) {
					for (const block of item.body.blocks) {
						if (block.text) {
							for (const [url] of block.text.matchAll(urlRegex)) {
								console.log(`[fanbox] Found URL in block text: ${url}`);
								urls.add(url);
							}
						}
					}
				}
				if (item.body.urlEmbedMap) {
					for (const urlEmbed of Object.values(item.body.urlEmbedMap)) {
						console.log(`[fanbox] Processing URL embed: ${urlEmbed.id}`);
						const embedUrlResults = urlEmbed.html?.match?.(urlRegex);
						if (embedUrlResults) {
							const embedUrl = embedUrlResults[0];
							console.log(`[fanbox] Found URL in URL embed: ${embedUrl}`);
							if (embedUrl.startsWith('https://cdn.iframe.ly/')) {
								console.log(`[fanbox] Found iframe.ly URL in URL embed: ${embedUrl}`);
								await wait(3000);
								const response = await axios.get(embedUrl);
								const matches = response.data.match(/<meta name="canonical" content="(?<url>[^"]+)"\/>/);
								if (matches?.groups?.url) {
									console.log(`[fanbox] Found canonical URL in iframe.ly URL embed: ${matches.groups.url}`);
									urls.add(matches.groups.url);
								}
							} else {
								urls.add(embedUrl);
							}
						}
					}
				}
			}
		}

		console.log(`[fanbox] Found ${urls.size} URLs in existing entries`);
		await writeFile('fanbox-urls.txt', `${Array.from(urls).join('\n')}\n`, {encoding: 'utf-8', flag: 'a'});
	}
};

if (require.main === module) {
	main();
}
