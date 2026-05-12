# skyo-prediction

Browser-only short-term precipitation forecasting. Pulls recent radar imagery (RainViewer), estimates cloud motion via optical flow, and extrapolates the rain field forward in time — all client-side. No backend, no ML weights, no compilation step.

**[Live demo →](https://d-dezeeuw.github.io/skyo-prediction/)**

## Status

Early development. See the [plan](https://github.com/D-dezeeuw/skyo-prediction) for the phased roadmap.

## Stack

- **UI / state**: [Spektrum](https://www.npmjs.com/package/spektrum) (vanilla JS, loaded from CDN via importmap)
- **Map**: Leaflet
- **Radar source**: RainViewer (free, CORS-enabled tiles)
- **Compute**: WebGL for optical flow and semi-Lagrangian advection; pure-JS reference implementations for testability
- **No build step beyond a `public/` → `dist/` copy** — same pattern as [Skyo](https://github.com/D-dezeeuw/weather-app-spektrum)

## Quick start

```bash
npm start         # serves public/ on http://localhost:3000
npm run build     # produces dist/
npm test          # unit tests (node --test)
npm run test:coverage
```

## License

MIT — see [LICENSE](./LICENSE).
