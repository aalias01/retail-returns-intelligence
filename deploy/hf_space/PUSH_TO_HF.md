# Push this staging directory to Hugging Face Spaces

## One-time setup

1. Create a Space at https://huggingface.co/new-space
   - Name: `retail-returns-intelligence`
   - SDK: **Docker**
   - Hardware: **CPU Basic**
   - Visibility: **Public**

2. Sync serving files into this staging directory (from the GitHub repo root):

```bash
cd /path/to/retail-returns-intelligence
bash deploy/hf_space/sync_to_space.sh
```

3. Clone the empty Space repo:

```bash
git clone https://huggingface.co/spaces/alvinalias/retail-returns-intelligence
cd retail-returns-intelligence
```

4. Copy staged deploy files into the HF clone (exclude helper scripts):

```bash
rsync -av \
  /path/to/retail-returns-intelligence/deploy/hf_space/ \
  /path/to/retail-returns-intelligence-clone/ \
  --exclude sync_to_space.sh \
  --exclude PUSH_TO_HF.md
```

5. Commit and push to Hugging Face:

```bash
cd /path/to/retail-returns-intelligence-clone
git add README.md Dockerfile requirements.txt api src models
git commit -m "Deploy retail returns API on HF Spaces"
git push
```

HF builds automatically. Space URL:

```text
https://alvinalias-retail-returns-intelligence.hf.space
```

## Verify

```bash
curl -s https://alvinalias-retail-returns-intelligence.hf.space/health
curl -s "https://alvinalias-retail-returns-intelligence.hf.space/demo-cases?limit=2"
```

## After HF is live

1. Update `HF_SPACE_URL` in `.github/workflows/wake_hf_space.yml` if needed.
2. Test the Vercel preview from branch `hf-space-api`.
3. Merge `hf-space-api` to `main` only after the acceptance checklist in `docs_local/HF_SPACES_MIGRATION.md` passes.
