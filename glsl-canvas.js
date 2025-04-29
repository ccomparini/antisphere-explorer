
class GLSLCanvas extends HTMLElement {
  constructor() {
    super();
    this.canvas = document.createElement("canvas");
    this.attachShadow({ mode: "open" }).append(this.canvas);
    this.gl = null;
    this.program = null;
    this.uniforms = {};
  }

  connectedCallback() {
    this.canvas.width = this.clientWidth;
    this.canvas.height = this.clientHeight;
    this.gl = this.canvas.getContext("webgl2") || this.canvas.getContext("webgl");

    if (!this.gl) {
      console.error("WebGL not supported");
      return;
    }

    const vsURL = this.getAttribute("data-vertex-shader");
    const fsURL = this.getAttribute("data-fragment-shader");

    Promise.all([fetch(vsURL), fetch(fsURL)])
      .then(responses => Promise.all(responses.map(r => r.text())))
      .then(([vsSource, fsSource]) => {
        this.program = this.initShaderProgram(vsSource, fsSource);
        this.initUniformsFromAttributes();
        this.animate();
      });
  }

  initShaderProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vertexShader = this.loadShader(gl.VERTEX_SHADER, vsSource);
    const fragmentShader = this.loadShader(gl.FRAGMENT_SHADER, fsSource);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Unable to initialize shader program:", gl.getProgramInfoLog(program));
      return null;
    }

    return program;
  }

  loadShader(type, source) {
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error("An error occurred compiling shaders:", this.gl.getShaderInfoLog(shader));
      this.gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  setUniform(name, value) {
    this.uniforms[name] = value;
  }

  setUniforms(map) {
    for (const [name, value] of Object.entries(map)) {
      this.setUniform(name, value);
    }
  }

  updateUniform(name, value) {
    const gl = this.gl;
    const loc = gl.getUniformLocation(this.program, name);
    if (!loc) return;

    if (typeof value === "number") gl.uniform1f(loc, value);
    else if (value.length === 2) gl.uniform2f(loc, ...value);
    else if (value.length === 3) gl.uniform3f(loc, ...value);
    else if (value.length === 4) gl.uniform4f(loc, ...value);
    else if (value.length === 16) gl.uniformMatrix4fv(loc, false, value);
  }

  initUniformsFromAttributes() {
    const dataset = this.dataset;
    for (const key in dataset) {
      if (!key.startsWith("uniform")) continue;

      const match = key.match(/^uniform([A-Z][a-zA-Z0-9]*)$/);
      if (!match) continue;

      const type = match[1].toLowerCase();
      const [name, ...vals] = dataset[key].split(/=|,/);
      const parsed = vals.map(v => parseFloat(v)).filter(v => !isNaN(v));
      this.setUniform(name.trim(), parsed.length ? parsed : true);
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    this.draw();
  }

  draw() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);

    // Update uniforms
    for (const name in this.uniforms) {
      this.updateUniform(name, this.uniforms[name]);
    }

    // Draw a fullscreen triangle
    if (!this.fullscreenBuffer) {
      this.fullscreenBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fullscreenBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        gl.STATIC_DRAW
      );
    }

    const posLoc = gl.getAttribLocation(this.program, "a_position");
    if (posLoc >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fullscreenBuffer);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

customElements.define("glsl-canvas", GLSLCanvas);

