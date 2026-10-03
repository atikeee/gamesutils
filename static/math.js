(function () {
  function drawingCanvas(canvas) {
    var context = canvas.getContext('2d');
    var hidden = document.getElementById(canvas.dataset.input);
    context.lineWidth = 4;
    context.lineCap = 'round';
    context.strokeStyle = '#172329';
    if (hidden.value) { var image = new Image(); image.onload = function () { context.drawImage(image, 0, 0); }; image.src = hidden.value; }
    var drawing = false;
    function point(event) { var rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }; }
    canvas.addEventListener('pointerdown', function (event) { drawing = true; canvas.setPointerCapture(event.pointerId); var p = point(event); context.beginPath(); context.moveTo(p.x, p.y); });
    canvas.addEventListener('pointermove', function (event) { if (!drawing) return; var p = point(event); context.lineTo(p.x, p.y); context.stroke(); hidden.value = canvas.toDataURL('image/png'); });
    canvas.addEventListener('pointerup', function () { drawing = false; hidden.value = canvas.toDataURL('image/png'); });
    canvas.parentElement.querySelector('.clear-drawing').addEventListener('click', function () { context.clearRect(0, 0, canvas.width, canvas.height); hidden.value = ''; });
  }
  document.querySelectorAll('.draw-canvas').forEach(drawingCanvas);
  document.querySelectorAll('.graph-widget').forEach(function (widget) {
    var canvas = widget.querySelector('canvas'), context = canvas.getContext('2d'), points = JSON.parse(widget.dataset.points || '[]');
    context.strokeStyle = '#d8d5ca'; context.lineWidth = 1;
    for (var x = 40; x < canvas.width; x += 40) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, canvas.height); context.stroke(); }
    for (var y = 20; y < canvas.height; y += 40) { context.beginPath(); context.moveTo(0, y); context.lineTo(canvas.width, y); context.stroke(); }
    context.strokeStyle = '#172329'; context.lineWidth = 2; context.beginPath(); context.moveTo(40, canvas.height / 2); context.lineTo(canvas.width - 20, canvas.height / 2); context.moveTo(canvas.width / 2, 20); context.lineTo(canvas.width / 2, canvas.height - 20); context.stroke();
    if (points.length) { context.strokeStyle = '#087f78'; context.lineWidth = 4; context.beginPath(); points.forEach(function (point, index) { var px = canvas.width / 2 + point[0] * 35, py = canvas.height / 2 - point[1] * 35; if (!index) context.moveTo(px, py); else context.lineTo(px, py); }); context.stroke(); }
  });
  document.querySelectorAll('.geometry-example').forEach(function (widget) {
    var config = JSON.parse(widget.dataset.config || '{}'), canvas = widget.querySelector('.geometry-example-canvas'), context = canvas.getContext('2d');
    var rangeX = config.xRange || [-10, 10], rangeY = config.yRange || [-6, 6];
    function scaleX(value) { return (value - rangeX[0]) * canvas.width / (rangeX[1] - rangeX[0]); }
    function scaleY(value) { return canvas.height - (value - rangeY[0]) * canvas.height / (rangeY[1] - rangeY[0]); }
    function drawLine(start, end) { context.beginPath(); context.moveTo(scaleX(start[0]), scaleY(start[1])); context.lineTo(scaleX(end[0]), scaleY(end[1])); context.stroke(); }
    context.fillStyle = '#fbfaf5'; context.fillRect(0, 0, canvas.width, canvas.height); context.strokeStyle = '#e4e0d5'; context.lineWidth = 1;
    for (var x = Math.ceil(rangeX[0]); x <= rangeX[1]; x += 1) drawLine([x, rangeY[0]], [x, rangeY[1]]);
    for (var y = Math.ceil(rangeY[0]); y <= rangeY[1]; y += 1) drawLine([rangeX[0], y], [rangeX[1], y]);
    context.strokeStyle = '#172329'; context.lineWidth = 2; if (rangeY[0] <= 0 && rangeY[1] >= 0) drawLine([rangeX[0], 0], [rangeX[1], 0]); if (rangeX[0] <= 0 && rangeX[1] >= 0) drawLine([0, rangeY[0]], [0, rangeY[1]]);
    (config.shapes || []).forEach(function (shape) { var coordinates = shape.points || []; context.strokeStyle = shape.color || '#087f78'; context.fillStyle = shape.fill || 'rgba(8, 127, 120, .12)'; context.lineWidth = 4; if (shape.type === 'circle') { var radiusX = scaleX(coordinates[1][0]) - scaleX(coordinates[0][0]); context.beginPath(); context.arc(scaleX(coordinates[0][0]), scaleY(coordinates[0][1]), Math.abs(radiusX), 0, Math.PI * 2); context.fill(); context.stroke(); } else if (shape.type === 'point') { context.beginPath(); context.arc(scaleX(coordinates[0][0]), scaleY(coordinates[0][1]), 6, 0, Math.PI * 2); context.fill(); } else { context.beginPath(); coordinates.forEach(function (point, index) { if (!index) context.moveTo(scaleX(point[0]), scaleY(point[1])); else context.lineTo(scaleX(point[0]), scaleY(point[1])); }); if (shape.closed !== false) context.closePath(); context.fill(); context.stroke(); } });
  });
  document.querySelectorAll('.geometry-widget').forEach(function (widget) {
    var config = JSON.parse(widget.dataset.config || '{}');
    var canvas = widget.querySelector('.geometry-canvas');
    var context = canvas.getContext('2d');
    var status = widget.querySelector('.geometry-status');
    var rangeX = config.xRange || [-10, 10], rangeY = config.yRange || [-6, 6];
    var selectedShape = (config.shapes || ['point'])[0], points = [], shapes = [];
    function scaleX(value) { return (value - rangeX[0]) * canvas.width / (rangeX[1] - rangeX[0]); }
    function scaleY(value) { return canvas.height - (value - rangeY[0]) * canvas.height / (rangeY[1] - rangeY[0]); }
    function coordinate(event) { var rect = canvas.getBoundingClientRect(); return { x: Math.round((rangeX[0] + (event.clientX - rect.left) * (rangeX[1] - rangeX[0]) / rect.width) * 10) / 10, y: Math.round((rangeY[1] - (event.clientY - rect.top) * (rangeY[1] - rangeY[0]) / rect.height) * 10) / 10 }; }
    function drawPoint(point, color) { context.fillStyle = color || '#e46b3d'; context.beginPath(); context.arc(scaleX(point.x), scaleY(point.y), 5, 0, Math.PI * 2); context.fill(); }
    function drawSegment(start, end, extendStart, extendEnd) {
      var dx = end.x - start.x, dy = end.y - start.y;
      if (extendStart || extendEnd) { var length = Math.sqrt(dx * dx + dy * dy) || 1; var ux = dx / length, uy = dy / length; if (extendStart) start = { x: start.x - ux * 100, y: start.y - uy * 100 }; if (extendEnd) end = { x: end.x + ux * 100, y: end.y + uy * 100 }; }
      context.beginPath(); context.moveTo(scaleX(start.x), scaleY(start.y)); context.lineTo(scaleX(end.x), scaleY(end.y)); context.stroke();
    }
    function drawShape(shape) {
      context.strokeStyle = '#087f78'; context.fillStyle = 'rgba(8, 127, 120, .10)'; context.lineWidth = 3;
      if (shape.type === 'point') drawPoint(shape.points[0]);
      if (['segment', 'line', 'ray'].indexOf(shape.type) >= 0) drawSegment(shape.points[0], shape.points[1], shape.type === 'line', shape.type === 'line' || shape.type === 'ray');
      if (['triangle', 'polygon', 'rectangle'].indexOf(shape.type) >= 0) { context.beginPath(); shape.points.forEach(function (point, index) { if (!index) context.moveTo(scaleX(point.x), scaleY(point.y)); else context.lineTo(scaleX(point.x), scaleY(point.y)); }); context.closePath(); context.fill(); context.stroke(); }
      if (shape.type === 'circle') { var dx = shape.points[1].x - shape.points[0].x, dy = shape.points[1].y - shape.points[0].y; context.beginPath(); context.arc(scaleX(shape.points[0].x), scaleY(shape.points[0].y), Math.sqrt(Math.pow(dx * canvas.width / (rangeX[1] - rangeX[0]), 2) + Math.pow(dy * canvas.height / (rangeY[1] - rangeY[0]), 2)), 0, Math.PI * 2); context.fill(); context.stroke(); }
    }
    function grid() { context.clearRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#fbfaf5'; context.fillRect(0, 0, canvas.width, canvas.height); context.strokeStyle = '#e4e0d5'; context.lineWidth = 1; for (var x = Math.ceil(rangeX[0]); x <= rangeX[1]; x += 1) { context.beginPath(); context.moveTo(scaleX(x), 0); context.lineTo(scaleX(x), canvas.height); context.stroke(); } for (var y = Math.ceil(rangeY[0]); y <= rangeY[1]; y += 1) { context.beginPath(); context.moveTo(0, scaleY(y)); context.lineTo(canvas.width, scaleY(y)); context.stroke(); } context.strokeStyle = '#172329'; context.lineWidth = 2; if (rangeY[0] <= 0 && rangeY[1] >= 0) { context.beginPath(); context.moveTo(0, scaleY(0)); context.lineTo(canvas.width, scaleY(0)); context.stroke(); } if (rangeX[0] <= 0 && rangeX[1] >= 0) { context.beginPath(); context.moveTo(scaleX(0), 0); context.lineTo(scaleX(0), canvas.height); context.stroke(); } }
    function repaint() { grid(); shapes.forEach(drawShape); points.forEach(function (point) { drawPoint(point, '#e46b3d'); }); }
    function requiredPoints() { return { point: 1, segment: 2, line: 2, ray: 2, triangle: 3, rectangle: 2, circle: 2, polygon: 3 }[selectedShape] || 1; }
    function finish() { if (points.length < requiredPoints()) return; var finalPoints = points.slice(); if (selectedShape === 'rectangle') { var first = finalPoints[0], second = finalPoints[1]; finalPoints = [first, { x: second.x, y: first.y }, second, { x: first.x, y: second.y }]; } shapes.push({ type: selectedShape, points: finalPoints }); points = []; repaint(); status.textContent = 'Shape added. Choose a tool to draw another shape.'; }
    canvas.addEventListener('pointerdown', function (event) { points.push(coordinate(event)); repaint(); if (selectedShape !== 'polygon' && points.length >= requiredPoints()) finish(); else status.textContent = selectedShape === 'polygon' ? 'Add at least 3 points, then choose Finish shape.' : 'Add ' + (requiredPoints() - points.length) + ' more point' + (requiredPoints() - points.length === 1 ? '' : 's') + '.'; });
    widget.querySelectorAll('.shape-tool').forEach(function (button) { button.addEventListener('click', function () { widget.querySelectorAll('.shape-tool').forEach(function (tool) { tool.classList.remove('selected'); }); button.classList.add('selected'); selectedShape = button.dataset.shape; points = []; repaint(); status.textContent = 'Drawing ' + selectedShape + '. Tap the coordinate plane.'; }); });
    widget.querySelector('.geometry-finish').addEventListener('click', finish);
    widget.querySelector('.geometry-undo').addEventListener('click', function () { shapes.pop(); repaint(); });
    widget.querySelector('.geometry-clear').addEventListener('click', function () { shapes = []; points = []; repaint(); });
    repaint();
  });
}());