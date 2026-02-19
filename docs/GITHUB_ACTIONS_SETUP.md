# GitHub Actions Setup

## Overview

This project uses GitHub Actions for continuous integration and deployment, including automated tagging and Docker image building.

## Required Secrets

For the automated workflows to function properly, the following secret must be configured in your repository:

### PAT_TOKEN

A **Personal Access Token (PAT)** with appropriate permissions is required for the auto-tagging workflow to trigger the Docker build workflow.

**Why this is needed:**

By default, when a GitHub Action uses the `GITHUB_TOKEN` to create and push tags, it does not trigger other workflows. This is a security feature to prevent recursive workflow runs. To allow the auto-tag workflow to trigger the Docker build workflow when a new version tag is created, we need to use a Personal Access Token instead.

**How to create and configure:**

1. **Create a Personal Access Token:**
   - Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Click "Generate new token (classic)"
   - Give it a descriptive name (e.g., "chains-api-auto-tag")
   - Select the following scopes:
     - `repo` (Full control of private repositories)
     - Or at minimum: `repo:status`, `repo_deployment`, `public_repo`
   - Click "Generate token" and copy the token value

2. **Add the token as a repository secret:**
   - Go to your repository Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `PAT_TOKEN`
   - Value: Paste the Personal Access Token you created
   - Click "Add secret"

## Workflows

### Auto Tag Workflow (`.github/workflows/auto-tag.yml`)

This workflow automatically creates and pushes a git tag when the `package.json` version is updated on the `main` branch.

**Triggers:**
- Push to `main` branch
- When `package.json` is modified

**Process:**
1. Checks out the repository with full history (using `PAT_TOKEN`)
2. Reads the version from `package.json`
3. Checks if a tag with that version already exists
4. If not, creates and pushes the new tag (e.g., `v1.0.5`)

**Note:** The workflow uses `PAT_TOKEN` in the checkout action to ensure that the tag push triggers the Docker build workflow.

### Docker Build Workflow (`.github/workflows/docker-build.yml`)

This workflow builds and pushes Docker images to GitHub Container Registry (GHCR).

**Triggers:**
- Push to `main` branch
- Push of tags matching `v*` pattern (e.g., `v1.0.5`)
- Pull requests to `main` branch
- Manual workflow dispatch

**Process:**
1. Runs tests and SonarQube analysis
2. Builds Docker image
3. Pushes to GHCR (when not a pull request)
4. Tags images with:
   - Version tags (e.g., `v1.0.5`, `1.0.5`, `1.0`, `1`)
   - `latest` for main branch pushes
   - Branch/PR specific tags

## Troubleshooting

### Tags are created but Docker images are not built

This typically indicates that the `PAT_TOKEN` secret is not configured or has insufficient permissions. Verify:

1. The `PAT_TOKEN` secret exists in your repository settings
2. The token has the required `repo` scope
3. The token has not expired

### Workflow permission errors

If you see permission errors in the workflow logs, ensure that:

1. The repository settings allow GitHub Actions to create and push tags:
   - Settings → Actions → General → Workflow permissions
   - Select "Read and write permissions"
   - Enable "Allow GitHub Actions to create and approve pull requests"

2. The `PAT_TOKEN` has the necessary permissions (see "Required Secrets" section above)

## Version Management

To release a new version:

1. Update the version in `package.json`:
   ```bash
   npm version patch  # for 1.0.5 -> 1.0.6
   npm version minor  # for 1.0.5 -> 1.1.0
   npm version major  # for 1.0.5 -> 2.0.0
   ```

2. Commit and push to `main`:
   ```bash
   git commit -am "Release version X.Y.Z"
   git push
   ```

3. The auto-tag workflow will:
   - Detect the version change in `package.json`
   - Create and push a new tag (e.g., `v1.0.6`)
   - Trigger the Docker build workflow
   - Build and push the Docker image with the new version tag

## Manual Tagging

If you need to manually create a tag:

```bash
git tag v1.0.5
git push origin v1.0.5
```

This will trigger the Docker build workflow directly. Manual tag pushes will trigger the workflow regardless of the authentication method you use (SSH keys, HTTPS with PAT, etc.), as the workflow is triggered by the tag push event itself.
