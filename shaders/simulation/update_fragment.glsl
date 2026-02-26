precision highp float;
precision highp int;

uniform sampler2D texture;
uniform vec2 delta;
uniform float damping;
uniform float speed;
varying vec2 coord;


void main() {
  vec4 info = texture2D(texture, coord);

  vec2 dx = vec2(delta.x, 0.0);
  vec2 dy = vec2(0.0, delta.y);
  float average = (
    texture2D(texture, coord - dx).r +
    texture2D(texture, coord - dy).r +
    texture2D(texture, coord + dx).r +
    texture2D(texture, coord + dy).r
  ) * 0.25;

  info.g += (average - info.r) * speed;
  info.g *= damping;
  info.r += info.g;

  gl_FragColor = info;
}
