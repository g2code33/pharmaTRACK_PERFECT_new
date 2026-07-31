# Manual step: add the CI test gate

I could not push this change myself — GitHub blocks the Arena app from editing
`.github/workflows/**` without extra `workflows` permission. It is a two-line
edit you can make in about 30 seconds.

## Why bother

Right now a release can be built and published even if the tests fail or the
version is inconsistent across the 5 files. The version one matters most: if
`src-tauri/tauri.conf.json` lags behind, the updater silently never offers the
update to anyone, and you would not find out until users complained.

## What to do

1. Open `.github/workflows/release.yml`
2. Find this block (around line 33, in the **build-windows** job):

```yaml
      - run: npm install --legacy-peer-deps
      - run: npm run build
```

3. Replace it with:

```yaml
      - run: npm install --legacy-peer-deps

      # Gate the release on the test suite and on the version being consistent
      # across all 5 files. If tauri.conf.json lags behind, the updater silently
      # never offers the update to anyone, so it is worth failing the build here.
      - name: Check version consistency
        run: npm run version:check
      - name: Run tests
        run: npm test

      - run: npm run build
```

4. Commit and push.

Only the **build-windows** job needs it — it runs first, and the Linux job
depends on it (`needs: build-windows`), so a failure stops the whole release.

## Check it worked

Push to `main` and open the Actions tab. You should see two new steps,
**Check version consistency** and **Run tests**, both green before the build
step runs.

You can delete this file once done.
