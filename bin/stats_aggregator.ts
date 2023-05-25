import {createHash} from 'crypto';
import {promises as fs} from 'fs';
import {initializeApp, applicationDefault, cert} from 'firebase-admin/app';
import {getFirestore, Timestamp, FieldValue} from 'firebase-admin/firestore';
import {chunk} from 'lodash';

const md5 = (data: string) => createHash('md5').update(data).digest('hex');

const percentileNumbers = [5, 6, 7, 8, 9, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90];

interface TagStat {
	count: number,
	totalWeights: number,
	percentiles: {
		[percentile: number]: number,
	},
}

(async () => {
	const files = await fs.readdir('.');
	const serviceAccountFile = files.find((file) => file.endsWith('.json') && file.includes('firebase-adminsdk'));
	const serviceAccount = JSON.parse((await fs.readFile(serviceAccountFile || '')).toString());

	initializeApp({
		credential: cert(serviceAccount),
	});

	const db = getFirestore();

	const Media = db.collection('media');

	const mediaHashset = new Map<string, {[hash: string]: string}>();
	for (const i of Array(256).keys()) {
		const prefix = i.toString(16).padStart(2, '0');
		mediaHashset.set(prefix, {});
	}

	const tagStats = new Map<string, TagStat>();

	const mediaSnapshot = await Media.get();
	mediaSnapshot.forEach((mediaDoc) => {
		const hash = md5(mediaDoc.id);
		const hashPrefix = hash.slice(0, 2);
		mediaHashset.get(hashPrefix)![hash] = mediaDoc.id;

		for (const [tag, weight] of Object.entries(mediaDoc.get('danbooru_tags') ?? {}) as [string, number][]) {
			if (!tagStats.has(tag)) {
				tagStats.set(tag, {
					count: 0,
					totalWeights: 0,
					percentiles: Object.fromEntries(percentileNumbers.map((percentile) => [percentile, 0])),
				});
			}

			const tagStat = tagStats.get(tag)!;

			tagStat.count++;

			tagStat.totalWeights += weight;

			for (const percentile of percentileNumbers) {
				if (weight >= percentile / 100) {
					tagStat.percentiles[percentile]++;
				}
			}
		}
	});


	for (const [hashPrefix, hashset] of mediaHashset) {
		console.log(`Writing hashset ${hashPrefix}`);

		const hashsetRef = db.collection('media_hashset').doc(hashPrefix);
		await hashsetRef.set(hashset, {merge: true});
	}

	for (const tagStatsChunk of chunk([...tagStats.entries()], 500)) {
		const batch = db.batch();

		for (const [tag, tagStat] of tagStatsChunk) {
			const tagRef = db.collection('danbooru_tag_stats').doc(tag.replaceAll(/\//g, '|'));
			batch.set(tagRef, tagStat);
		}

		await batch.commit();
	}
})();
