from huggingface_hub import snapshot_download
from zipfile import ZipFile
from pathlib import Path
from urllib.parse import urlparse
import json
import pyarrow as pa

schema = pa.schema([
	pa.field('danbooru_id', pa.int32()),
	pa.field('pixiv_id', pa.int32()),
])

download_dir = snapshot_download(
	repo_type="dataset",
	repo_id="stma/danbooru-metadata",
	allow_patterns="posts/*.zip",
)

processed = 0
sinked = 0
with pa.OSFile('danbooru_pixiv_mappings.arrow', 'wb') as sink:
	with pa.ipc.new_file(sink, schema) as writer:
		for post_file in (Path(download_dir) / 'posts').iterdir():
			zipfile = ZipFile(post_file)
			for filename in zipfile.namelist():
				if processed % 10000 == 0:
					print(f'Processed {processed} posts, sinked {sinked} mappings...')

				processed += 1

				if not filename.endswith('.json'):
					continue

				data = json.loads(zipfile.read(filename))

				source = data.get('source')
				if source is None:
					continue

				try:
					source_url = urlparse(source)
				except Exception as e:
					print(f'Failed to parse source URL {source}')
					print(e)
					continue

				artwork_id = None
				if source_url.netloc.endswith('pximg.net'):
					filename = Path(source_url.path).stem
					artwork_id = filename.split('_')[0]
				elif source_url.netloc.endswith('pixiv.net'):
					if 'artworks' in source_url.path:
						artwork_id = source_url.path.split('/')[-1]
					elif source_url.netloc.startswith('i'):
						artwork_id = Path(source_url.path).stem

				if artwork_id is None or not artwork_id.isdigit():
					continue

				if int(artwork_id) == 0 or int(artwork_id) > 1000000000:
					continue

				writer.write_batch(pa.RecordBatch.from_arrays([
					pa.array([data['id']]),
					pa.array([int(artwork_id)]),
				], schema=schema))
				sinked += 1
