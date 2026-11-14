---
name: tdd-threejs
description: Conventions of the TDD slices of 3D models, covering `.shape.test.ts` shape tests, the model budget file and the split with `[ts]` slices.
---

# Conventions for a 3D model slice

Applies to `[threejs]` slices, in the directory that the `threejs` entry of `.awf/languages.yaml` names (`dir`): building Three.js meshes and materials. For geometry, load the `threejs-geometry` skill; for materials, `threejs-materials`.

## Shape tests

- Vitest, in `*.shape.test.ts` files placed next to the tested model. The `.unit`, `.functional` and `.integration` levels stay with `[ts]` slices.
- One test per scenario of the spec, named after its behaviour.
- The test walks the group with `traverse`, keeps the `Mesh` objects, counts the distinct materials and the triangles (`geometry.index.count / 3`, or `position.count / 3` without an index). It does not need WebGL.
- It reads the limits of the model's family in the project's model budget file, the one that the `budget` check of the registry reads (`{ "<family>": { "triangles": n, "materials": n } }` in the example registry), and copies none of its values.

## Rendering conventions

- One mesh per material (`mergeGeometries`), vertex colours, `flatShading`.
- Any domain or application computation (a footprint, for instance) goes in a `[ts]` slice: mutation testing does not cover `[threejs]` slices, so `domain/` or `application/` code there would escape it.

## Exceptions

- Throw a project subclass of `Error`, named after the problem. No `throw` of a string, an object, a bare `Error` or a native class.
- An error thrown by the engine or a native API is converted with `cause`.
- The message contains no interpolated data: the context goes into typed properties.

## Review

The review runs the tools of `review_steps` in the `threejs` entry: `tsc`, ESLint, dependency-cruiser and Vitest, then the budget gate and the capture gate in the example registry. There is no mutation testing. A capture mismatch or a missing reference stops the slice for an art direction decision.

Do not run these tools during RED or GREEN, except Vitest, and never the capture.
