# Math Content

The math application is driven by the directory tree under `data/math`. Adding a chapter, lesson, or test normally requires adding JSON files; the Flask routes discover them automatically.

## Directory structure

```text
data/math/
├── README.md
├── algebra/
│   ├── chapter.json
│   ├── learn/
│   │   └── lesson-name.json
│   └── test/
│       └── test-name.json
├── exponents/
│   ├── chapter.json
│   ├── learn/
│   │   └── lesson-name.json
│   └── test/
│       └── test-name.json
└── geometry/
    ├── chapter.json
    ├── learn/
    │   └── lesson-name.json
    └── test/
        └── test-name.json
```

The folder names become URL slugs. For example:

```text
data/math/algebra/learn/fraction-of-fraction.json
```

is available at:

```text
/mathlearning/algebra/fraction-of-fraction
```

The filename is the lesson or test slug. Use URL-safe filenames with lowercase letters, numbers, hyphens, or underscores. Do not add a `slug` field to lesson or test JSON files.

## Chapter metadata

Each chapter needs a `chapter.json` file:

```json
{
  "title": "Linear relationships",
  "description": "Build confidence with equations, tables, and coordinate graphs."
}
```

`title` and `description` appear on the chapter card. The chapter folder name is the authoritative URL slug, so this file should be stored at `data/math/algebra/chapter.json`.

## Lesson blocks

Lesson JSON files contain a `blocks` array. The currently supported block types are:

### `text`

Paragraph content.

```json
{
  "type": "text",
  "body": "A fraction of a quantity means multiplication."
}
```

### `equation`

LaTeX rendered by MathJax. JSON requires doubled backslashes:

```json
{
  "type": "equation",
  "latex": "\\frac{2}{3} \\times \\frac{5}{7} = \\frac{10}{21}"
}
```

Complex expressions can use normal LaTeX commands such as `\\frac`, `\\sqrt`, `\\text`, `\\sum`, `\\int`, `\\begin{aligned}`, and superscripts/subscripts.

### `callout`

A highlighted explanation, reminder, or activity:

```json
{
  "type": "callout",
  "title": "Try it",
  "body": "Explain why multiplying two proper fractions gives a result smaller than either fraction."
}
```

### `coordinate-plane`

A simple plotted line or sequence of points:

```json
{
  "type": "coordinate-plane",
  "label": "Points on y = x + 1",
  "points": [[-2, -1], [0, 1], [2, 3]]
}
```

### `geometry-example`

A static coordinate-based diagram for a lesson. It supports points and connected shapes:

```json
{
  "type": "geometry-example",
  "label": "A triangle on a coordinate plane",
  "xRange": [-8, 8],
  "yRange": [-5, 5],
  "shapes": [
    {
      "type": "triangle",
      "points": [[-5, -2], [0, 4], [5, -2]]
    },
    {
      "type": "point",
      "points": [[0, 4]],
      "color": "#e46b3d"
    }
  ]
}
```

### `geometry-drawing`

An interactive coordinate canvas. Students can draw points, segments, lines, rays, triangles, rectangles, circles, and polygons.

```json
{
  "type": "geometry-drawing",
  "xRange": [-8, 8],
  "yRange": [-5, 5],
  "shapes": ["point", "segment", "line", "ray", "triangle", "rectangle", "circle", "polygon"]
}
```

## Test question types

Test JSON files contain a `questions` array and a `grading` value:

```json
{
  "title": "Linear relationships check-in",
  "description": "Review the chapter ideas.",
  "grading": "auto",
  "questions": []
}
```

### `single`

One correct option. Set `answer` to the option ID.

### `multi`

Several correct options. Set `answer` to an array of option IDs.

### `write`

A typed answer. Set `answer` to the expected text. The current comparison is exact, so use a consistent answer format such as `1/6`.

### `draw`

A freehand canvas answer. Drawings are stored with the student's attempt as a PNG data URL and are intended for manual review.

Example:

```json
{
  "id": "q1",
  "type": "draw",
  "prompt": "Draw a triangle on the coordinate plane."
}
```

## Saved answers

When a student clicks **Save progress** or **Finish test**, all answers are written to `data/math/progress.json`, keyed by the student's Flask session ID and test path. This includes typed answers, selected options, and drawing canvases.

Submitting with **Finish test** sets `completed` to `true`. Completed tests are highlighted on the practice index. **Reset and retake test** removes that student's saved answers, score, and completion state for the selected test.

Do not edit `progress.json` as lesson content. It is generated runtime data and may contain student work.

## Useful future types

The current model covers the initial learning and practice needs. Useful future additions include:

- `worked-example` for numbered solution steps
- `table` for value tables and comparisons
- `image` for prepared diagrams
- `hint` for optional guided help
- `numeric` for answers with numeric tolerance
- `expression` for algebraic answer checking
- `matching` for matching terms, graphs, and formulas
- `ordering` for arranging solution steps
- `multi-part` for related answers in one question
- `graph-question` for student-created plotted functions
- `teacher-rubric` for structured manual grading