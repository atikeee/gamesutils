const HEX_SIZE = 80;
const TILE_RADIUS = HEX_SIZE;
const NUMBER_RADIUS = HEX_SIZE * 0.3;
const ROAD_WIDTH = 12;
const HOUSE_SIZE = 20;
const CITY_SIZE = 30;
const PORT_SIZE = HEX_SIZE * 0.3;

const PLAYER_COLORS = {
    'player1': '#FF6347',
    'player2': '#4682B4',
    'player3': '#32CD32',
    'player4': '#FFD700'
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
    'wood': '/static/images/catan/wood.jpg',
    'brick': '/static/images/catan/brick.jpg',
    'sheep': '/static/images/catan/sheep.jpg',
    'hay': '/static/images/catan/hay.jpg',
    'rock': '/static/images/catan/rock.jpg',
    'desert': '/static/images/catan/desert.jpg',
};

const PORT_DATA = [
    null, null, null, null, null, null, null, null,
    ['wood', '2:1'], ['brick', '2:1'], ['sheep', '2:1'],
    null, null,
    ['any', '3:1'],
    null, null,
    ['hay', '2:1'],
    null, null,
    ['any', '3:1'],
    null, null,
    ['rock', '2:1'],
    null,
    ['any', '3:1'],
    null, null,
    ['any', '3:1'],
    null, null
];

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

function drawHex(ctx, x, y, size, fillColor, image = null, strokeColor = '#333', lineWidth = 2) {
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

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
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

function drawWoodPortIcon(ctx, x, y, iconSize) {
    ctx.fillStyle = '#8B4513';
    ctx.fillRect(x - iconSize * 0.2, y - iconSize * 0.2, iconSize * 0.4, iconSize * 0.4);
    ctx.strokeStyle = '#654321';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - iconSize * 0.2, y - iconSize * 0.2, iconSize * 0.4, iconSize * 0.4);
}

function drawBrickPortIcon(ctx, x, y, iconSize) {
    ctx.fillStyle = '#B22222';
    const brickWidth = iconSize * 0.4;
    const brickHeight = iconSize * 0.15;
    ctx.fillRect(x - brickWidth / 2, y - brickHeight / 2, brickWidth, brickHeight);
    ctx.strokeStyle = '#8B0000';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - brickWidth / 2, y - brickHeight / 2, brickWidth, brickHeight);
}

function drawSheepPortIcon(ctx, x, y, iconSize) {
    ctx.fillStyle = '#F0F8FF';
    ctx.strokeStyle = '#696969';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, iconSize * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
}

function drawhayPortIcon(ctx, x, y, iconSize) {
    ctx.fillStyle = '#FFD700';
    ctx.strokeStyle = '#B8860B';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - iconSize * 0.3);
    ctx.lineTo(x - iconSize * 0.1, y + iconSize * 0.1);
    ctx.lineTo(x + iconSize * 0.1, y + iconSize * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
}

function drawOrePortIcon(ctx, x, y, iconSize) {
    ctx.fillStyle = '#A9A9A9';
    ctx.strokeStyle = '#696969';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, iconSize * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
}

function drawCirclePort(ctx, x, y, type, ratio, backgroundImage = null) {
    ctx.save();
    ctx.translate(x, y);

    const circleRadius = PORT_SIZE;
    ctx.beginPath();
    ctx.arc(0, 0, circleRadius, 0, Math.PI * 2);

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
    if (type !== 'any') {
        switch (type) {
            case 'wood': drawWoodPortIcon(ctx, 0, iconYOffset, iconSize); break;
            case 'brick': drawBrickPortIcon(ctx, 0, iconYOffset, iconSize); break;
            case 'sheep': drawSheepPortIcon(ctx, 0, iconYOffset, iconSize); break;
            case 'hay': drawhayPortIcon(ctx, 0, iconYOffset, iconSize); break;
            case 'rock': drawOrePortIcon(ctx, 0, iconYOffset, iconSize); break;
        }
    } else {
        ctx.fillStyle = '#333';
        ctx.font = `bold ${iconSize * 0.7}px Inter`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', 0, iconYOffset);
    }

    ctx.fillStyle = '#333';
    ctx.font = `bold ${PORT_SIZE * 0.4}px Inter`;
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

function drawRobber(ctx, tile, offsetX, offsetY) {
    const pixel = hexToPixel(tile.q, tile.r, offsetX, offsetY);
    const x = pixel.x;
    const y = pixel.y;
    const robberSize = HEX_SIZE * 0.3;

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
