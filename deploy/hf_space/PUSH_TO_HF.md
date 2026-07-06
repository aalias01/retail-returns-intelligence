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

1. Add `HF_TOKEN` to GitHub repo secrets (Settings → Secrets → Actions). Use the same Hugging Face write token you used for the first manual push.
2. The workflow `.github/workflows/sync_hf_space.yml` pushes `deploy/hf_space/` to HF when `api/`, `src/`, `models/`, or `requirements.txt` change on `main`. Run it manually from the Actions tab via **workflow_dispatch** if needed.
3. Test the Vercel preview from branch `hf-space-api` (historical; production is on `main` after cutover).
4. Merge `hf-space-api` to `main` only after the acceptance checklist in `docs_local/HF_SPACES_MIGRATION.md` passes.

## GitHub Actions setup (one time)

1. Create a Hugging Face write token at https://huggingface.co/settings/tokens
2. In GitHub: **aalias01/retail-returns-intelligence → Settings → Secrets and variables → Actions → New repository secret**
3. Name: `HF_TOKEN` · Value: your HF write token
4. Push any API change to `main`, or trigger **Sync Retail HF Space** manually from the Actions tab

After the first successful Action run, you can delete the local clone:

```bash
rm -rf ~/retail-returns-hf
```
