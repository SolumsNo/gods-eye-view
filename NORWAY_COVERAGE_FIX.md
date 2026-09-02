# Astro Weather Norway – coverage fix

This patch fixes apparent gaps in the Norway-wide Astro Weather overlay.

The forecast grid itself was present, but rectangles were rendered at a fixed
35 m ellipsoid height. In mountainous Norway, and especially with Google
Photorealistic 3D Tiles, much of that geometry could be occluded by the map.

Changes:
- render weather rectangles as ground classification geometry
- classify both terrain and Cesium 3D Tiles
- add a tiny overlap between adjacent cells to suppress hairline seams
- keep the existing 48-hour forecast, locations, colors and scoring

Install by copying the patch contents into the existing gods-eye-view project.
