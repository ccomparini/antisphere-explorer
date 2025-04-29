const canvas = document.getElementById("glCanvas");
const gl = canvas.getContext("webgl2");
canvas.width = window.innerWidth - 400;
canvas.height = window.innerHeight;

const vertEditor = document.getElementById("vertShader");
const fragEditor = document.getElementById("fragShader");

// Load initial shaders
async function loadInitialShaders() {
    vertEditor.value = await fetch("shaders/basic.vert").then(r => r.text());
    fragEditor.value = await fetch("shaders/sphere.frag").then(r => r.text());
    compileAndDraw();
}

let program, positionLoc;

function compileShader(src, type) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        return null;
    }
    return shader;
}

function createProgram(vsSrc, fsSrc) {
    const vs = compileShader(vsSrc, gl.VERTEX_SHADER);
    const fs = compileShader(fsSrc, gl.FRAGMENT_SHADER);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(prog));
        return null;
    }
    return prog;
}

function setupGeometry() {
    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,  1, -1, -1, 1,
         1, -1,  1,  1, -1, 1,
    ]), gl.STATIC_DRAW);

    positionLoc = 0;
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
}

function compileAndDraw() {
    const vsSrc = vertEditor.value;
    const fsSrc = fragEditor.value;
    const newProgram = createProgram(vsSrc, fsSrc);
    if (newProgram) {
        program = newProgram;
        gl.useProgram(program);
        setupGeometry();
        draw();
    }
}

function draw(time = 0) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const u_res = gl.getUniformLocation(program, "u_resolution");
    if (u_res) gl.uniform2f(u_res, canvas.width, canvas.height);

    const u_time = gl.getUniformLocation(program, "u_time");
    if (u_time) gl.uniform1f(u_time, time * 0.001);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(draw);
}

vertEditor.addEventListener("input", compileAndDraw);
fragEditor.addEventListener("input", compileAndDraw);

loadInitialShaders();

