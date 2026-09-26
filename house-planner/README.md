# Nivas house planner

A browser-based planner for residential houses on Indian plots. Enter the plot size, road side, setbacks, number of bedrooms and floors, and it:

- **Generates a floor plan** for every floor: living, dining, kitchen, bedrooms with attached toilets, pooja, staircase, car parking, balconies. Walls line up floor to floor and the staircase stays in the same place.
- **Lets you edit it**: drag rooms, drag an edge to resize, type exact sizes, add, duplicate, rotate or delete rooms. Rooms snap to a 3-inch (or 5 cm) grid and to each other's edges. Undo/redo with Ctrl+Z / Ctrl+Shift+Z; arrow keys nudge the selected room.
- **Draws doors and windows automatically**: door swings, open archways between living areas, windows and ventilators on outside walls, main entry on the road side.
- **Shows the house in 3D** (three.js): walls with openings, slabs, dog-legged stairs, balcony parapets, terrace with stair headroom, compound wall, road and car. "Cut at floor" removes the floors above so you can look inside.
- **Works out the details**: area statement (built-up, carpet, coverage, FAR, height), room schedule with flooring suggestions, a cost estimate by finish level with a breakdown, thumb-rule material quantities, a door & window schedule, Vastu zone checks and NBC 2016 minimum-size checks.
- **Exports** the plan and the 3D view as PNG images and the whole project as a `.json` file you can open again. Work is also kept in the browser between visits.

Units switch between feet-inches and metres. Everything runs in the browser; there is no server and no build step.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout |
| `styles.css` | Styles, light and dark themes |
| `js/core.js` | Layout generator, doors/windows, Vastu, areas, cost and materials |
| `js/plan2d.js` | SVG floor plan drawing and drag/resize editing |
| `js/view3d.js` | 3D model (three.js 0.160 from cdn.jsdelivr.net) |
| `js/app.js` | Form, panels, undo/redo, details report, export |

## Running it

The scripts are ES modules, so open the page over HTTP (not as a `file://` path):

```sh
cd house-planner
python3 -m http.server 8000
# then open http://localhost:8000
```

It is a static site, so any static host works: GitHub Pages, Cloudflare Pages, Netlify, or a folder on an existing server. It is kept separate from the TenderOne site in `public/` and is not deployed with the Worker.

## Limits

The plan is a concept for early decisions and conversations with an architect. The generator uses rectangular rooms in three bands (rear, middle, front); odd-shaped plots, columns and beams, and structural design are not modelled. Costs and quantities use common per-sq-ft thumb rules and vary by city and design. Check setbacks, coverage and FAR against your local bylaws before applying for approval.
