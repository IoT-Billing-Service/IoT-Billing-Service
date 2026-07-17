import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');

for (const image of ['backend', 'frontend']) {
  assert.match(
    workflow,
    new RegExp(`uses: docker/build-push-action@v6[\\s\\S]*?cache-from: type=gha,scope=${image}-image[\\s\\S]*?cache-to: type=gha,mode=max,scope=${image}-image`),
    `${image} image must use an isolated GitHub Actions Buildx cache`,
  );

  const dockerfile = await readFile(resolve(root, image, 'Dockerfile'), 'utf8');
  assert.match(
    dockerfile,
    /COPY (?:package\*\.json|package\.json package-lock\.json) \.\//,
    `${image} Dockerfile must copy dependency manifests before application sources`,
  );
  assert.match(dockerfile, /RUN npm ci/, `${image} Dockerfile must use reproducible installs`);
}

console.log('Docker cache configuration is valid.');
