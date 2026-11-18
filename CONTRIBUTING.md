# Contributing

## Development

Development uses Node.js 24. With [nvm](https://github.com/nvm-sh/nvm), run `nvm use` in the repository.
The package supports Node.js 22 and later, and CI runs every check on both 22 and 24.

    npm ci
    npm test

| Script                 | What it does                                      |
| ---------------------- | ------------------------------------------------- |
| `npm test`             | Runs the tests with the Node.js test runner       |
| `npm run typecheck`    | Type checks `src`, `example` and `test`           |
| `npm run lint`         | Lints with ESLint. `npm run lint:fix` fixes       |
| `npm run format`       | Formats with Prettier. `format:check` only checks |
| `npm run compile`      | Builds `dist` with tsup                           |

A pre-commit hook (husky and lint-staged) lints and formats the files you commit.
CI runs all checks on every push to `develop` and on pull requests.

## Release process

Follow these steps on `develop`, with a clean working tree.

### Update `CHANGELOG.md`

- Rename the `[Unreleased]` section to the new version and today's date, and add a new empty
  `[Unreleased]` section above it.
- Add a link for the new version at the bottom of the file.

Commit the change:

    git commit -am "Update changelog for vX.Y.Z"

### Bump the version

This updates `package.json`, commits, and creates the `vX.Y.Z` tag:

    npm version X.Y.Z
    git push --follow-tags

### Publish to npm

`prepublishOnly` runs the lint, type check, tests and build first.

    npm publish --access public
