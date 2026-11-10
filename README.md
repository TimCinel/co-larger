# co-larger

An open-source photo collage maker that runs entirely in your browser. Photos
never leave your machine: there is no backend.

Unlike most collage makers, tile sizes are configurable, from uniform to a few
very large "feature" photos among many small ones. See [spec.md](spec.md) for
the planned scope. The app is at an early stage and currently shows a
placeholder page.

## Development

Requires Node.js 24 or later.

```sh
npm install
npm run dev
```

| Command             | What it does                                       |
| ------------------- | -------------------------------------------------- |
| `npm run dev`       | Start the Vite dev server.                         |
| `npm run build`     | Build the static site into `dist/`.                |
| `npm run preview`   | Serve the built site locally.                      |
| `npm test`          | Run the unit tests once (Vitest).                  |
| `npm run lint`      | Run ESLint and check formatting with Prettier.     |
| `npm run format`    | Format all files with Prettier.                    |
| `npm run typecheck` | Type check with `tsc`.                             |
| `npm run check`     | Run lint, type check, tests and build, as CI does. |

The build uses relative asset URLs, so `dist/` can be hosted at the root of a
domain or under any sub-path.

## Licence

[MIT](LICENSE)
