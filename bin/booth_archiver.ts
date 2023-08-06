import {basename} from 'path';
import {Mutex} from 'async-mutex';
import axios from 'axios';
import * as concatStream from 'concat-stream';
import {scrapeHTML} from 'scrape-it';
import * as unzipper from 'unzipper';
import {db, s3, incrementCounter, uploadImage} from '../lib/aws';

const uploadMutex = new Mutex();

const uploadStream = async (stream: NodeJS.ReadableStream, s3key: string) => {
	const fileBuffer = await new Promise<Buffer>((resolve, reject) => {
		stream.pipe(concatStream({encoding: 'buffer'}, (data) => {
			resolve(data);
		}));
		stream.on('error', reject);
	});

	if (s3key.match(/\.(?:png|jpg|jpeg|gif|bmp)$/)) {
		console.log(`[booth] Uploading ${s3key} as image (size = ${fileBuffer.length})`);
		await uploadImage(fileBuffer, s3key);
	} else {
		console.log(`[booth] Uploading ${s3key} as file (size = ${fileBuffer.length})`);
		await s3.upload({
			Bucket: 'hakataarchive',
			Key: s3key,
			Body: fileBuffer,
			StorageClass: 'GLACIER_IR',
		}).promise();
	}
	await incrementCounter('BoothFileSaved');
};

(async () => {
	const orders = process.argv.slice(2).map((arg) => {
		if (arg.startsWith('https://accounts.booth.pm/orders/')) {
			return arg;
		}
		if (arg.match(/^\d+$/)) {
			return `https://accounts.booth.pm/orders/${arg}`;
		}
		throw new Error(`Invalid order ID: ${arg}`);
	});

	if (orders.length === 0) {
		throw new Error('No order ID specified.');
	}

	const sessionData = await db.get({
		TableName: 'hakataarchive-sessions',
		Key: {
			id: 'booth',
		},
	}).promise();
	const {session} = sessionData.Item;

	console.log(`[booth] Session ID retrieved (session = ${session}).`);

	for (const orderUrl of orders) {
		const {data} = await axios.get(orderUrl, {
			headers: {
				Cookie: session,
			},
		});

		const {downloadables} = scrapeHTML<{downloadables: {url: string}[]}>(data.toString(), {
			downloadables: {
				listItem: '.l-order-detail-by-shop .sheet',
				data: {
					url: {
						selector: 'a.nav-reverse',
						attr: 'href',
					},
				},
			},
		});

		const validDownloadables = downloadables.filter(({url}) => url !== '');

		console.log(`[booth] Found ${validDownloadables.length} downloadables in order ${orderUrl}`);
		console.log(`[booth] downloadables = ${JSON.stringify(validDownloadables, null, 2)}`);

		for (const downloadable of validDownloadables) {
			console.log(`[booth] Retrieving download URL for ${downloadable.url}`);

			const {headers} = await axios.get(downloadable.url, {
				headers: {
					Cookie: session,
				},
				maxRedirects: 0,
				validateStatus: null,
			});
			const downloadUrl = headers.location;

			console.log(`[booth] Downloading ${downloadUrl}`);

			const {data: fileData, headers: fileHeaders, request} = await axios.get(downloadUrl, {
				responseType: 'stream',
				maxRedirects: 0,
				validateStatus: null,
			});

			const {pathname} = new URL(downloadUrl);
			const filename = decodeURIComponent(basename(pathname)).replaceAll('/', '_');
			const [,,, itemId, downloadableId] = pathname.split('/');

			console.log(`[booth] Saving ${filename} (itemId = ${itemId}, downloadableId = ${downloadableId} size = ${fileHeaders['content-length']}))`);

			if (fileHeaders['content-type'] === 'application/zip') {
				const stream = fileData.pipe(unzipper.Parse());
				stream.on('entry', async (entry) => {
					if (entry.type === 'File') {
						const s3key = `booth/${itemId}/${downloadableId}/${filename}/${entry.path}`;
						console.log(`[booth] Adding to uploading queue: ${s3key}`);
						await uploadMutex.runExclusive(async () => {
							await uploadStream(entry, s3key);
						});
					} else {
						entry.autodrain();
					}
				});

				await new Promise((resolve, reject) => {
					stream.on('finish', resolve);
					stream.on('error', reject);
				});
			} else {
				const s3key = `booth/${itemId}/${downloadableId}/${filename}`;
				console.log(`[booth] Adding to uploading queue: ${s3key}`);
				await uploadMutex.runExclusive(async () => {
					await uploadStream(fileData, s3key);
				});
			}
		}
	}
})();
