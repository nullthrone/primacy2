# Models used by the listening tools

The project requires a licence check before a model's first use. One entry per model; date of every
check: 2026-11-14. The cache is `~/.cache/huggingface/hub/models--<org>--<name>/snapshots/<hash>/`.

## Qwen/Qwen2-Audio-7B-Instruct (tools/audio/listen/describe.py)

- Licence: Apache-2.0 (YAML header `license: apache-2.0` of the model card).
- Read in: `models--Qwen--Qwen2-Audio-7B-Instruct/snapshots/0a095220c30b7b31434169c3086508ef3ea5bf0a/README.md`
- Checked: 2026-11-14.

## laion/larger_clap_general (tools/audio/listen/compare.py)

- Licence: Apache-2.0. The cached snapshot
  (`models--laion--larger_clap_general/snapshots/ada0c23a36c4e8582805bb38fec3905903f18b41/`) holds
  only config, tokenizer and weights and no model card, so the licence was read from the model's
  page data instead: `https://huggingface.co/api/models/laion/larger_clap_general` gives
  `license: apache-2.0` for revision `ada0c23a36c4e8582805bb38fec3905903f18b41`, the revision in
  the cache.
- The tool only reads the model locally and writes numbers; no weights or model output are shipped
  in the game.
- Checked: 2026-11-14. The model had already been run by then (the listening tools were built and
  tested before the page data was read).

## openai/whisper-small (tools/audio/listen/transcribe.py)

- Licence: Apache-2.0. The snapshot
  (`models--openai--whisper-small/snapshots/973afd24965f72e36ca33b3055d56a652f456b4d/`) holds no
  model card, so the licence was read from the model's page data:
  `https://huggingface.co/api/models/openai/whisper-small` gives `license: apache-2.0` for
  revision `973afd24965f72e36ca33b3055d56a652f456b4d`, the revision in the cache.
- Same use as above: local measurement only, nothing shipped.
- Checked: 2026-11-14, after the model's first run (see above).
