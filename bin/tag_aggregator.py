import pyarrow as pa
from pyarrow import json
from pathlib import Path

schema = pa.schema([
	pa.field('key', pa.string(), metadata={'description': 'The unique key of the image.'}),
	pa.field('tag_probs', pa.list_(pa.float32()), metadata={'description': 'List of probabilities for each tag. The index of each probability corresponds to the index of the tag in the https://github.com/RF5/danbooru-pretrained/raw/master/config/class_names_6000.json file.'}),
	pa.field('class', pa.int8(), metadata={'description': 'Class of the image.'}),
])

pixiv_ids = json.read_json('pixiv.json')

public_ids = set([int(id.as_py()) for id in pixiv_ids['public'][0]])
private_ids = set([int(id.as_py()) for id in pixiv_ids['private'][0]])

with pa.OSFile('all_tags.arrow', 'wb') as sink:
	with pa.ipc.new_stream(sink, schema) as writer:
		i = 0
		with pa.memory_map('pixiv_tags.arrow', 'rb') as source:
			loaded_array = pa.ipc.open_file(source)
			table = loaded_array.read_all()
			for raw_key, raw_tag_probs in zip(table['key'], table['tag_probs']):
				i += 1
				if i % 10000 == 0:
					print(f'Processed {i} pixiv images...')
				key = raw_key.as_py()
				tag_probs = raw_tag_probs.as_py()
				if 'pixiv' in key:
					filename = Path(key).stem
					artwork_id = int(filename.split('_')[0])

					if artwork_id not in public_ids and artwork_id not in private_ids:
						print(f'Skipping {key} because it is not public or private.')
						continue

					writer.write_batch(pa.RecordBatch.from_arrays([
						pa.array([key]),
						pa.array([tag_probs]),
						pa.array([1 if artwork_id in public_ids else 2]),
					], schema=schema))

		i = 0
		with pa.memory_map('danbooru_tags.arrow', 'rb') as source:
			loaded_array = pa.ipc.open_file(source)
			table = loaded_array.read_all()
			for raw_danbooru_id, raw_tag_probs in zip(table['danbooru_id'], table['tag_probs']):
				i += 1
				if i % 10000 == 0:
					print(f'Processed {i} danbooru images...')
				danbooru_id = raw_danbooru_id.as_py()
				tag_probs = raw_tag_probs.as_py()
				key = f'danbooru/{danbooru_id}.jpg'

				writer.write_batch(pa.RecordBatch.from_arrays([
					pa.array([key]),
					pa.array([tag_probs]),
					pa.array([0]),
				], schema=schema))
