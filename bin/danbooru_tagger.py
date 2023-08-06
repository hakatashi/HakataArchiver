from huggingface_hub import hf_hub_download
import sys
from urllib import request
import random
from zipfile import ZipFile
from tagger import get_raw_tags
from PIL import Image
from pathlib import Path
import json
import pyarrow as pa

bookmarked_pixiv_ids = set()
with pa.memory_map('pixiv_tags.arrow', 'rb') as source:
	loaded_array = pa.ipc.open_file(source)
	table = loaded_array.read_all()
	for key_scalar in table['key']:
		key = key_scalar.as_py()
		if 'pixiv' in key:
			filename = Path(key).stem
			artwork_id = filename.split('_')[0]
			bookmarked_pixiv_ids.add(int(artwork_id))

print(f'Loaded {len(bookmarked_pixiv_ids)} bookmarked pixiv IDs.')

danbooru_to_pixiv = {}
with pa.memory_map('danbooru_pixiv_mappings.arrow', 'rb') as source:
	table = pa.ipc.open_file(source).read_all()
	danbooru_to_pixiv = {danbooru_id.as_py(): pixiv_id.as_py() for danbooru_id, pixiv_id in zip(table['danbooru_id'], table['pixiv_id'])}

print(f'Loaded {len(danbooru_to_pixiv)} danbooru to pixiv mappings.')

danbooru_files_response = request.urlopen('https://huggingface.co/api/datasets/animelover/danbooru2022/tree/main/data')
danbooru_files = json.load(danbooru_files_response)

danbooru_zip_files = set([file['path'] for file in danbooru_files if file['path'].endswith('.zip')])

schema = pa.schema([
	pa.field('danbooru_id', pa.string(), metadata={'description': 'Danbooru ID of the image.'}),
	pa.field('tag_probs', pa.list_(pa.float32()), metadata={'description': 'List of probabilities for each tag. The index of each probability corresponds to the index of the tag in the https://github.com/RF5/danbooru-pretrained/raw/master/config/class_names_6000.json file.'}),
])

processed = 0
sinked = 0
bookmarked = 0

with pa.OSFile('danbooru_tags.arrow', 'wb') as sink:
	with pa.ipc.new_file(sink, schema) as writer:
		while sinked < 200000:
			zip_file = random.choice(list(danbooru_zip_files))
			danbooru_zip_files.remove(zip_file)

			print(f'Processing {zip_file}...')

			zip_local_path = hf_hub_download(repo_id='animelover/danbooru2022', filename=zip_file, repo_type='dataset', cache_dir='F:\\.cache')

			print(f'Loaded {zip_file} to {zip_local_path}')

			zipfile = ZipFile(zip_local_path)
			for filename in zipfile.namelist():
				if not filename.endswith('.jpg'):
					continue

				processed += 1

				danbooru_id = int(Path(filename).stem)
				pixiv_id = danbooru_to_pixiv.get(danbooru_id)

				print(f'Danbooru ID: {danbooru_id}, pixiv ID: {pixiv_id}')

				if pixiv_id is None:
					continue
				if pixiv_id in bookmarked_pixiv_ids:
					bookmarked += 1
					continue

				try:
					input_image = Image.open(zipfile.open(filename))
				except Exception as e:
					print('Image open failed')
					print(e)
					continue

				print('Loaded image (format = {}, size = {}, mode = {})'.format(input_image.format, input_image.size, input_image.mode))
				image_format = input_image.format
				width, height = input_image.size

				try:
					if input_image.mode != 'RGB':
						input_image = input_image.convert('RGB')
				except Exception as e:
					print('Image conversion failed')
					print(e)
					continue

				print('Tagging image...')

				try:
					tags_obj = get_raw_tags(input_image)
				except Exception as e:
					print('Image tagging failed')
					print(e)
					continue

				writer.write_batch(pa.RecordBatch.from_arrays([
					pa.array([danbooru_id]),
					pa.array([tags_obj.numpy()]),
				], schema=schema))

				sinked += 1

print(f'Processed {processed} posts, {bookmarked} bookmarked posts, sinked {sinked} tags.')