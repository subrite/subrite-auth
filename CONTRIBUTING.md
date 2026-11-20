# Contributing

## Development

Development uses Node.js 24. With [nvm](https://github.com/nvm-sh/nvm), run `nvm use` in the repository.
The package supports Node.js 22 and later, and CI runs every check on both 22 and 24.

    npm ci
    npm test

| Script                 | What it does                                                  |
| ---------------------- | ------------------------------------------------------------- |
| `npm test`             | Runs the tests with the Node.js test runner                   |
| `npm run test:package` | Builds and packs the package, then checks it in fixture apps  |
| `npm run typecheck`    | Type checks `src`, `example`, `test` and `scripts`            |
| `npm run lint`         | Lints with ESLint. `npm run lint:fix` fixes                   |
| `npm run format`       | Formats with Prettier. `format:check` only checks             |
| `npm run compile`      | Builds `dist` with tsup                                       |
| `npm run upgrade`      | Updates dependencies, except the majors Dependabot also skips |

A pre-commit hook (husky and lint-staged) lints and formats the files you commit.
CI runs all checks on every push to `develop` and on pull requests.

## Release process

### In the release pull request

- In `CHANGELOG.md`, give the changes under `[Unreleased]` their version heading, add a new empty
  `[Unreleased]` section above it, and add a link for the new version at the bottom.
- Bump the version. `preversion` runs the lint, format check, type check and tests first:

      npm version X.Y.Z --no-git-tag-version

### After merging

On the merged commit, put the release date in the `CHANGELOG.md` heading if it is still missing,
then tag and publish. `prepublishOnly` runs the lint, type check, tests and package check first.

    git tag vX.Y.Z
    git push origin vX.Y.Z
    npm publish --access public
