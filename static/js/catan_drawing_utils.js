const HEX_SIZE = 80;
const TILE_RADIUS = HEX_SIZE;
const NUMBER_RADIUS = HEX_SIZE * 0.3;
const ROAD_WIDTH = 12;
const HOUSE_SIZE = 20;
const CITY_SIZE = 30;
const PORT_SIZE = HEX_SIZE * 0.3;
window.SHOW_PORT_INDEX = true;
const PLAYER_COLORS = window.CATAN_PLAYER_COLORS || {
    'player1': '#F80000',
    'player2': '#0000CC',
    'player3': '#663300',
    'player4': '#FFFF00'
};

const RESOURCE_COLORS = {
    'wood': '#3CB371',
    'brick': '#CD5C5C',
    'sheep': '#90EE90',
    'hay': '#DAA520',
    'rock': '#708090',
    'desert': '#F4A460',
};
const NUMBER_COLOR = '#333';
const ROBBER_COLOR = '#333';

const resourceImagePaths = {
    'wood': '/static/images/catan/wood.webp',
    'brick': '/static/images/catan/brick.webp',
    'sheep': '/static/images/catan/sheep.webp',
    'hay': '/static/images/catan/hay.webp',
    'rock': '/static/images/catan/rock.webp',
    'desert': '/static/images/catan/desert.webp',
};


const PORT_PAIRS_4P = [
    { a: 1,  b: 2,  type: 'any',   ratio: '3:1' },
    { a: 9, b: 10, type: 'hay',  ratio: '2:1' },
    { a: 0, b: 5, type: 'brick',  ratio: '2:1' },
    { a: 21, b: 22, type: 'wood',  ratio: '2:1' },
    { a: 24, b: 26, type: 'rock',  ratio: '2:1' },
    { a: 6, b: 12, type: 'sheep',  ratio: '2:1' },
    { a: 13, b: 20, type: 'any',   ratio: '3:1' },
    { a: 7, b: 8, type: 'any',   ratio: '3:1' },
    { a: 17, b: 18, type: 'any',   ratio: '3:1' },
    
];



const PORT_PAIRS_6P = [
    // a, b = the two junction numbers (must share one edge)
    { a: 4,  b: 5,  type: 'wood',   ratio: '2:1' },
    { a: 1,  b: 2,  type: 'any',   ratio: '3:1' },
    { a: 9,  b: 10,  type: 'hay',   ratio: '2:1' },
    { a: 14,  b: 18,  type: 'any',   ratio: '3:1' },
    { a: 17,  b: 24,  type: 'rock',   ratio: '2:1' },
    { a: 33,  b: 31,  type: 'any',   ratio: '3:1' },
    { a: 34,  b: 35,  type: 'sheep',   ratio: '2:1' },
    { a: 29,  b: 30,  type: 'any',   ratio: '3:1' },
    { a: 21,  b: 22,  type: 'any',   ratio: '3:1' },
    { a: 16,  b: 11,  type: 'brick',   ratio: '2:1' },
    { a: 6,  b: 7,  type: 'sheep',   ratio: '2:1' },
    // { a: 9,  b: 10, type: 'rock',  ratio: '2:1' },
    // { a: 14, b: 15, type: 'brick', ratio: '2:1' },
    // types: 'any' | 'wood' | 'brick' | 'sheep' | 'hay' | 'rock'
	
];
function drawRailTrack(ctx, x1, y1, x2, y2) {
    const GAP = 22;                          // empty space left at the junction (px)
    const dx = x2 - x1, dy = y2 - y1;
    const fullLen = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / fullLen, uy = dy / fullLen;   // along the track
    const px = -uy, py = ux;                      // perpendicular
    const half = 7;
    const tieSpacing = 8;

    // start the track GAP pixels away from the junction
    const sx = x1 + ux * GAP;
    const sy = y1 + uy * GAP;
    const trackLen = fullLen - GAP;
    if (trackLen <= 0) return;

    ctx.save();
    ctx.lineCap = 'butt';

    // ties
    ctx.strokeStyle = '#8b6b3e';
    ctx.lineWidth = 4;
    for (let d = tieSpacing / 2; d < trackLen; d += tieSpacing) {
        const cx = sx + ux * d, cy = sy + uy * d;
        ctx.beginPath();
        ctx.moveTo(cx - px * (half + 2), cy - py * (half + 2));
        ctx.lineTo(cx + px * (half + 2), cy + py * (half + 2));
        ctx.stroke();
    }

    // rails
    ctx.strokeStyle = '#3b2a17';
    ctx.lineWidth = 3;
    [-half, half].forEach(o => {
        ctx.beginPath();
        ctx.moveTo(sx + px * o, sy + py * o);
        ctx.lineTo(x2 + px * o, y2 + py * o);
        ctx.stroke();
    });
    ctx.restore();
}

function drawPortPair(ctx, ja, jb, type, ratio, centerX, centerY) {
    // ja, jb, centerX, centerY are already in canvas coordinates (offset applied)
    const mx = (ja.x + jb.x) / 2;
    const my = (ja.y + jb.y) / 2;
    const ex = jb.x - ja.x;
    const ey = jb.y - ja.y;
    const len = Math.sqrt(ex * ex + ey * ey) || 1;

    // unit normal to the edge, flipped so it points away from the board center
    let nx = -ey / len;
    let ny = ex / len;
    if ((mx - centerX) * nx + (my - centerY) * ny < 0) { nx = -nx; ny = -ny; }

    // how far the port circle sits from the middle of the edge
    const portDistance = HEX_SIZE * 0.65;
    const px = mx + nx * portDistance;
    const py = my + ny * portDistance;

    // rail tracks from each junction to the port (drawn first, circle covers the ends)
    drawRailTrack(ctx, ja.x, ja.y, px, py);
    drawRailTrack(ctx, jb.x, jb.y, px, py);

    drawCirclePort(ctx, px, py, type, ratio);
}

function hexToPixel(q, r, offsetX, offsetY) {
    const x = HEX_SIZE * (3/2 * q);
    const y = HEX_SIZE * (Math.sqrt(3) * r + Math.sqrt(3)/2 * q);
    return { x: x + offsetX, y: y + offsetY };
}

function hexToRawPixel(q, r) {
    const x = HEX_SIZE * (3/2 * q);
    const y = HEX_SIZE * (Math.sqrt(3) * r + Math.sqrt(3)/2 * q);
    return { x: x, y: y };
}

function pixelToHex(px, py, offsetX, offsetY) {
    const x = px - offsetX;
    const y = py - offsetY;

    const q = (2/3 * x) / HEX_SIZE;
    const r = (-1/3 * x + Math.sqrt(3)/3 * y) / HEX_SIZE;

    let rx = Math.round(q);
    let ry = Math.round(r);
    let rz = Math.round(-q - r);

    const x_diff = Math.abs(rx - q);
    const y_diff = Math.abs(ry - r);
    const z_diff = Math.abs(rz - (-q - r));

    if (x_diff > y_diff && x_diff > z_diff) {
        rx = -ry - rz;
    } else if (y_diff > z_diff) {
        ry = -rx - rz;
    } else {
        rz = -rx - ry;
    }
    return { q: rx, r: ry };
}

function getHexVertices(centerX, centerY, size) {
    const vertices = [];
    for (let i = 0; i < 6; i++) {
        const angle_deg = 60 * i;
        const angle_rad = Math.PI / 180 * angle_deg;
        vertices.push({
            x: centerX + size * Math.cos(angle_rad),
            y: centerY + size * Math.sin(angle_rad)
        });
    }
    return vertices;
}
const TILE_OPACITY = 0.4;      // the tile picture/colour
const BORDER_OPACITY = 0.2;    // the hex outline (lower = fainter)

function drawHex(ctx, x, y, size, fillColor, image = null, strokeColor = '#333', lineWidth = 2) {
    ctx.globalAlpha = TILE_OPACITY;
    ctx.beginPath();
    const vertices = getHexVertices(x, y, size);
    ctx.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < 6; i++) {
        ctx.lineTo(vertices[i].x, vertices[i].y);
    }
    ctx.closePath();

    ctx.save();
    ctx.clip();

    if (image && image.complete && image.naturalWidth > 0) {
        const hexWidth = size * 2;
        const hexHeight = size * Math.sqrt(3);
        const scaleX = hexWidth / image.naturalWidth;
        const scaleY = hexHeight / image.naturalHeight;
        const scale = Math.max(scaleX, scaleY);

        const imgWidth = image.naturalWidth * scale;
        const imgHeight = image.naturalHeight * scale;

        ctx.drawImage(image, x - imgWidth / 2, y - imgHeight / 2, imgWidth, imgHeight);
    } else {
        ctx.fillStyle = fillColor;
        ctx.fill();
    }
    ctx.restore();

    // outline: separate opacity; custom colours (e.g. a highlighted tile) stay fully visible
    const isDefaultBorder = strokeColor === '#333';
    ctx.globalAlpha = isDefaultBorder ? BORDER_OPACITY : 1;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    ctx.globalAlpha = 1;
}

function drawNumber(ctx, x, y, number) {
    if (number === null) return;

    ctx.beginPath();
    ctx.arc(x, y, NUMBER_RADIUS, 0, Math.PI * 2);

    if (number === 6 || number === 8) {
        ctx.fillStyle = 'red';
        ctx.fill();
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = 'white';
    } else {
        ctx.fillStyle = '#FFFAF0';
        ctx.fill();
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = NUMBER_COLOR;
    }

    ctx.font = `bold ${NUMBER_RADIUS * 0.8}px Inter`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(number, x, y - NUMBER_RADIUS * 0.25);

    let numDots = 0;
    switch (number) {
        case 2: case 12: numDots = 1; break;
        case 3: case 11: numDots = 2; break;
        case 4: case 10: numDots = 3; break;
        case 5: case 9: numDots = 4; break;
        case 6: case 8: numDots = 5; break;
        default: numDots = 0;
    }

    const dotRadius = NUMBER_RADIUS * 0.08;
    const dotSpacing = NUMBER_RADIUS * 0.2;
    const startX = x - ((numDots - 1) * dotSpacing) / 2;
    const dotY = y + NUMBER_RADIUS * 0.35;

    ctx.fillStyle = (number === 6 || number === 8) ? 'white' : NUMBER_COLOR;
    for (let i = 0; i < numDots; i++) {
        ctx.beginPath();
        ctx.arc(startX + i * dotSpacing, dotY, dotRadius, 0, Math.PI * 2);
        ctx.fill();
    }
}


function drawCirclePort(ctx, x, y, type, ratio) {
    ctx.save();
    ctx.translate(x, y);

    const circleRadius = PORT_SIZE;
    ctx.beginPath();
    ctx.arc(0, 0, circleRadius, 0, Math.PI * 2);
    backgroundImage = null;
    if (type != 'any')
    {
        backgroundImage = loadedResourceImages[type];
    }
    if (backgroundImage && backgroundImage.complete && backgroundImage.naturalWidth > 0) {
        const imgScale = Math.max(circleRadius * 2 / backgroundImage.naturalWidth, circleRadius * 2 / backgroundImage.naturalHeight);
        const imgWidth = backgroundImage.naturalWidth * imgScale;
        const imgHeight = backgroundImage.naturalHeight * imgScale;
        ctx.clip();
        ctx.drawImage(backgroundImage, -imgWidth / 2, -imgHeight / 2, imgWidth, imgHeight);
    } else {
        ctx.fillStyle = '#D3D3D3';
        ctx.fill();
    }

    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.stroke();

    const iconSize = PORT_SIZE * 0.6;
    const iconYOffset = -circleRadius * 0.3;
    if (type === 'any') {
        ctx.fillStyle = '#333';
        ctx.font = `bold ${iconSize * 1.2}px Inter`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', 0, iconYOffset);
    }
    
    ctx.fillStyle = '#eef';
    ctx.font = `${PORT_SIZE * 0.8}px Inter`;
    
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ratioYOffset = circleRadius * 0.3;
    ctx.fillText(ratio, 0, ratioYOffset);

    ctx.restore();
}

function drawRoad(ctx, edge, color, offsetX, offsetY) {
    ctx.beginPath();
    ctx.moveTo(edge.x1 + offsetX, edge.y1 + offsetY);
    ctx.lineTo(edge.x2 + offsetX, edge.y2 + offsetY);
    ctx.strokeStyle = color;
    ctx.lineWidth = ROAD_WIDTH;
    ctx.lineCap = 'butt';
    ctx.stroke();
}

function drawHouse(ctx, junction, color, offsetX, offsetY) {
    const x = junction.x + offsetX;
    const y = junction.y + offsetY;
    const size = HOUSE_SIZE;

    ctx.fillStyle = color;
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;

    ctx.fillRect(x - size / 2, y - size / 2, size, size);
    ctx.strokeRect(x - size / 2, y - size / 2, size, size);

    ctx.beginPath();
    ctx.moveTo(x - size * 0.7, y - size / 2);
    ctx.lineTo(x + size * 0.7, y - size / 2);
    ctx.lineTo(x, y - size * 1.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#8B4513';
    ctx.fillRect(x - size * 0.15, y + size * 0.05, size * 0.3, size * 0.45);
    ctx.strokeRect(x - size * 0.15, y + size * 0.05, size * 0.3, size * 0.45);
}

function drawCity(ctx, junction, color, offsetX, offsetY) {
    const x = junction.x + offsetX;
    const y = junction.y + offsetY;
    const size = CITY_SIZE;

    ctx.fillStyle = color;
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;

    ctx.fillRect(x - size / 2, y - size / 2, size, size);
    ctx.strokeRect(x - size / 2, y - size / 2, size, size);

    ctx.fillRect(x - size * 0.4, y - size * 1.1, size * 0.3, size * 0.6);
    ctx.strokeRect(x - size * 0.4, y - size * 1.1, size * 0.3, size * 0.6);

    ctx.fillRect(x + size * 0.1, y - size * 1.1, size * 0.3, size * 0.6);
    ctx.strokeRect(x + size * 0.1, y - size * 1.1, size * 0.3, size * 0.6);

    ctx.fillRect(x - size / 2, y - size / 2 - 5, size / 5, 5);
    ctx.fillRect(x - size / 10, y - size / 2 - 5, size / 5, 5);
    ctx.fillRect(x + size / 5, y - size / 2 - 5, size / 5, 5);
}

function drawCityWall(ctx, junction, color, offsetX, offsetY) {
    const x = junction.x + offsetX;
    const y = junction.y + offsetY;
    const left = x - CITY_SIZE * 0.78;
    const right = x + CITY_SIZE * 0.78;
    const top = y - CITY_SIZE * 1.34;
    const bottom = y + CITY_SIZE * 0.68;
    const battlementHeight = CITY_SIZE * 0.22;
    const merlonWidth = CITY_SIZE * 0.24;
    const merlonStep = CITY_SIZE * 0.53;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(left, bottom);
    ctx.lineTo(left, top + battlementHeight);
    for (let merlon = 0; merlon < 3; merlon++) {
        const merlonX = left + merlon * merlonStep;
        ctx.lineTo(merlonX, top + battlementHeight);
        ctx.lineTo(merlonX, top);
        ctx.lineTo(merlonX + merlonWidth, top);
        ctx.lineTo(merlonX + merlonWidth, top + battlementHeight);
    }
    ctx.lineTo(right, top + battlementHeight);
    ctx.lineTo(right, bottom);
    ctx.closePath();

    ctx.strokeStyle = '#18242b';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
}

function drawKnight(ctx, junction, color, offsetX, offsetY, level = 1, active = false) {
    const x = junction.x + offsetX;
    const y = junction.y + offsetY;
    const knightLevel = Math.max(1, Math.min(3, Number(level) || 1));
    const radius = 11 + (knightLevel - 1) * 4;

    ctx.save();
    if (active) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffe34d';
        ctx.lineWidth = 3;
        ctx.shadowColor = '#ffe34d';
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#18242b';
    ctx.lineWidth = 2;
    ctx.stroke();

    for (let ring = 1; ring < knightLevel; ring++) {
        const ringRadius = radius * (ring === 1 ? 0.62 : 0.28);
        ctx.beginPath();
        ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
        ctx.strokeStyle = '#fff8df';
        ctx.lineWidth = 2;
        ctx.stroke();
    }
    ctx.restore();
}

function drawMerchant(ctx, tile, color, offsetX, offsetY) {
    const pixel = hexToPixel(tile.q, tile.r, offsetX, offsetY);
    const x = pixel.x + TILE_RADIUS * 0.42;
    const y = pixel.y;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y - 15);
    ctx.lineTo(x - 10, y + 7);
    ctx.quadraticCurveTo(x - 11, y + 15, x, y + 15);
    ctx.quadraticCurveTo(x + 11, y + 15, x + 10, y + 7);
    ctx.closePath();
    ctx.fillStyle = color || '#333';
    ctx.strokeStyle = '#172027';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(x, y + 7, 7, 2.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fill();
    ctx.restore();
}

function drawRobber(ctx, tile, offsetX, offsetY) {
    const pixel = hexToPixel(tile.q, tile.r, offsetX, offsetY);
    const x = pixel.x;
    const y = pixel.y;
    const robberSize = HEX_SIZE * 0.5;

    ctx.fillStyle = ROBBER_COLOR;
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.arc(x, y + robberSize * 0.4, robberSize * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x - robberSize * 0.3, y + robberSize * 0.4);
    ctx.lineTo(x - robberSize * 0.3, y - robberSize * 0.1);
    ctx.arc(x, y - robberSize * 0.1, robberSize * 0.3, Math.PI, 0, true);
    ctx.lineTo(x + robberSize * 0.3, y + robberSize * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y - robberSize * 0.4, robberSize * 0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
}

function isPointInNumberCircle(px, py, tile, offsetX, offsetY) {
    if (tile.number === null) return false;

    const pixel = hexToPixel(tile.q, tile.r, offsetX, offsetY);
    const dist = Math.sqrt(Math.pow(px - pixel.x, 2) + Math.pow(py - pixel.y, 2));
    return dist < NUMBER_RADIUS;
}

function countTilesForJunction(junction, boardTiles) {
    let count = 0;
    boardTiles.forEach(tile => {
        const rawPixel = hexToRawPixel(tile.q, tile.r);
        const vertices = getHexVertices(rawPixel.x, rawPixel.y, TILE_RADIUS);
        if (vertices.some(v => Math.abs(v.x - junction.x) < 1 && Math.abs(v.y - junction.y) < 1)) {
            count++;
        }
    });
    return count;
}
