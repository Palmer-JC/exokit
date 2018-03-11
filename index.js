#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const repl = require('repl');
const mkdirp = require('mkdirp');
const replHistory = require('repl.history');
const exokit = require('exokit-core');
const emojis = require('./assets/emojis');
const nativeBindingsModulePath = path.join(__dirname, 'native-bindings.js');
exokit.setNativeBindingsModule(nativeBindingsModulePath);
const {THREE} = exokit;
const nativeBindings = require(nativeBindingsModulePath);
const {nativeVideo, nativeVr, nativeWindow} = nativeBindings;

/* const {VERSION} = nativeGl;

nativeGl = {};
nativeGl.VERSION = VERSION; */
/* nativeGl.enable = () => {};
nativeGl.disable = () => {};
nativeGl.clear = () => {};
nativeGl.getExtension = () => null;
nativeGl.getParameter = id => {
  if (id === VERSION) {
    return 'WebGL 1';
  } else {
    return {};
  }
};
nativeGl.createTexture = () => {};
nativeGl.bindTexture = () => {};
nativeGl.texParameteri = () => {};
const _texImage2D = nativeGl.prototype.texImage2D;
nativeGl.prototype.texImage2D = function(a, b, c, d, e, f) {
  if (f.stack) {
    console.log('got teximage2d', f && f.constructor && f.constructor.name, f && f.stack);
  }
  try {
    return _texImage2D.apply(this, arguments);
  } catch(err) {
    console.log('failed teximage2d', f && f.constructor && f.constructor.name);

    throw err;
  }
};
nativeGl.clearColor = () => {};
nativeGl.clearDepth = () => {};
nativeGl.clearStencil = () => {};
nativeGl.depthFunc = () => {};
nativeGl.frontFace = () => {};
nativeGl.cullFace = () => {};
nativeGl.blendEquationSeparate = () => {};
nativeGl.blendFuncSeparate = () => {};
nativeGl.blendEquation = () => {};
nativeGl.blendFunc = () => {};
const _viewport = nativeGl.viewport;
nativeGl.viewport = function() {
  console.log('gl viewport', arguments, new Error().stack);
  _viewport.apply(this, arguments);
}; */

// CALLBACKS

const canvasSymbol = Symbol();
const windowHandleSymbol = Symbol();
const contexts = [];
const _windowHandleEquals = (a, b) => a[0] === b[0] && a[1] === b[1];
nativeBindings.nativeGl.onconstruct = (gl, canvas) => {
  gl[canvasSymbol] = canvas;
  gl[windowHandleSymbol] = nativeWindow.create(canvas.width || innerWidth, canvas.height || innerHeight);

  contexts.push(gl);
};

const nop = () => {};

const zeroMatrix = new THREE.Matrix4();
const localFloat32Array = zeroMatrix.toArray(new Float32Array(16));
const localFloat32Array2 = zeroMatrix.toArray(new Float32Array(16));
const localFloat32Array3 = zeroMatrix.toArray(new Float32Array(16));
const localFloat32Array4 = new Float32Array(16);
const localGamepadArray = new Float32Array(16);
const localVector = new THREE.Vector3();
const localVector2 = new THREE.Vector3();
const localQuaternion = new THREE.Quaternion();
const localMatrix = new THREE.Matrix4();
const localMatrix2 = new THREE.Matrix4();
const _normalizeMatrixArray = float32Array => {
  if (isNaN(float32Array[0])) {
    zeroMatrix.toArray(float32Array);
  }
};

let system = null;
let compositor = null;
let msFbo = null; // XXX track this per-context
let msTexture = null;
let fbo = null;
let texture = null;
let renderWidth = 0;
let renderHeight = 0;
const depthNear = 0.1;
const depthFar = 1000.0;
nativeVr.requestPresent = function() {
  // while booting we sometimes get transient errors
  const _requestSystem = () => new Promise((accept, reject) => {
    let err = null;
    const _recurse = (i = 0) => {
      if (i < 20) {
        const system = (() => {
          try {
            return nativeVr.system.VR_Init(nativeVr.EVRApplicationType.Scene);
          } catch (newErr) {
            err = newErr;
            return null;
          }
        })();
        if (system) {
          accept(system);
        } else {
          setTimeout(() => {
            _recurse(i + 1);
          }, 100);
        }
      } else {
        reject(err);
      };
    };
    _recurse();
  });

  return _requestSystem()
    .then(newSystem => {
      system = newSystem;
      compositor = nativeVr.compositor.NewCompositor();

      const {width: halfWidth, height} = system.GetRecommendedRenderTargetSize();
      renderWidth = halfWidth;
      renderHeight = height;

      window.updateVrFrame({
        renderWidth,
        renderHeight,
      });

      const width = halfWidth * 2;
      const [msFb, msTex] = nativeWindow.getRenderTarget(width, height, 4); // XXX switch to context first
      msFbo = msFb;
      msTexture = msTex;
      const [fb, tex] = nativeWindow.getRenderTarget(width, height, 1);
      fbo = fb;
      texture = tex;

      // nativeWindow.bindFrameBuffer(msFbo); // XXX unlock this
    });
};
nativeVr.exitPresent = function() {
  nativeVr.system.VR_Shutdown();
  system = null;
  compositor = null;

  // XXX switch to context first

  // nativeWindow.bindFrameBuffer(0); // XXX unlock this
  
  return Promise.resolve();
};

// EXPORTS

module.exports = exokit;

// MAIN

let window = null;
let innerWidth = 1280; // XXX do not track this globally
let innerHeight = 1024;
const FPS = 90;
const FRAME_TIME_MAX = 1000 / FPS;
const FRAME_TIME_MIN = FRAME_TIME_MAX / 5;
if (require.main === module) {
  const _prepare = () => {
    if (!process.env['DISPLAY']) {
      process.env['DISPLAY'] = ':0.0';
    }

    let rootPath = null;
    let runtimePath = null;
    const platform = os.platform();
    if (platform === 'linux') {
      rootPath = path.join(os.userInfo().homedir, '.config/openvr');
      runtimePath = path.join(__dirname, 'node_modules', 'native-openvr-deps/bin/linux64');
    } else if (platform === 'darwin') {
      rootPath = path.join('/Users/', os.userInfo().username, '/Library/Application Support/OpenVR/.openvr');
      runtimePath = path.join(__dirname, '/node_modules/native-openvr-deps/bin/osx64');
    }

    if (rootPath !== null) {
      const openvrPathsPath = path.join(rootPath, 'openvrpaths.vrpath');

      return new Promise((accept, reject) => {
        fs.lstat(openvrPathsPath, (err, stats) => {
          if (err) {
            if (err.code === 'ENOENT') {
              mkdirp(rootPath, err => {
                if (!err) {
                  const jsonString = JSON.stringify({
                    "config" : [ rootPath ],
                    "external_drivers" : null,
                    "jsonid" : "vrpathreg",
                    "log" : [ rootPath ],
                    "runtime" : [
                       runtimePath,
                     ],
                    "version" : 1
                  }, null, 2);
                  fs.writeFile(openvrPathsPath, jsonString, err => {
                    if (!err) {
                      accept();
                    } else {
                      reject(err);
                    }
                  });
                } else {
                  reject(err);
                }
              });
            } else {
              reject(err);
            }
          } else {
            accept();
          }
        });
      });
    } else {
      return Promise.resolve();
    }
  };
  const _start = () => {
    const url = process.argv[2];
    if (url) {
      return exokit.fetch(url)
        .then(site => {
          console.log('node site loaded');

          window = site.window;
          window.innerWidth = innerWidth;
          window.innerHeight = innerHeight;
          if (nativeVr.system.VR_IsHmdPresent()) {
            window.navigator.setVRMode('vr');
          }
          window.addEventListener('error', err => {
            console.warn('got error', err.error.stack);
          });

          let lastPointerLockElement = null;
          window.document.addEventListener('pointerlockchange', () => {
            const {pointerLockElement} = window.document;
            if (pointerLockElement && pointerLockElement._context && pointerLockElement._context.constructor && pointerLockElement._context.constructor.name === 'WebGLContext') {
              nativeWindow.setCursorMode(pointerLockElement._context[windowHandleSymbol], false);
            } else if (lastPointerLockElement && lastPointerLockElement._context && lastPointerLockElement._context.constructor && lastPointerLockElement._context.constructor.name === 'WebGLContext') {
              nativeWindow.setCursorMode(lastPointerLockElement._context[windowHandleSymbol], true);
            }
            lastPointerLockElement = pointerLockElement;
          });

          let lastFrameTime = Date.now();
          const leftGamepad = new window.Gamepad('left', 0);
          const rightGamepad = new window.Gamepad('right', 1);
          const gamepads = [null, null];
          const frameData = new window.VRFrameData();
          const stageParameters = new window.VRStageParameters();
          const _recurse = () => {
            if (compositor) {
              // wait for frame
              compositor.WaitGetPoses(
                system,
                localFloat32Array, // hmd
                localFloat32Array2, // left controller
                localFloat32Array3 // right controller
              );
              _normalizeMatrixArray(localFloat32Array);
              _normalizeMatrixArray(localFloat32Array2);
              _normalizeMatrixArray(localFloat32Array3);

              // build frame data
              const hmdMatrix = localMatrix.fromArray(localFloat32Array);

              hmdMatrix.decompose(localVector, localQuaternion, localVector2);
              frameData.pose.set(localVector, localQuaternion);

              hmdMatrix.getInverse(hmdMatrix);

              system.GetEyeToHeadTransform(0, localFloat32Array4);
              localMatrix2.fromArray(localFloat32Array4)
                .getInverse(localMatrix2)
                .multiply(hmdMatrix)
                .toArray(frameData.leftViewMatrix);

              system.GetProjectionMatrix(0, depthNear, depthFar, localFloat32Array4);
              _normalizeMatrixArray(localFloat32Array4);
              frameData.leftProjectionMatrix.set(localFloat32Array4);

              system.GetEyeToHeadTransform(1, localFloat32Array4);
              _normalizeMatrixArray(localFloat32Array4);
              localMatrix2.fromArray(localFloat32Array4)
                .getInverse(localMatrix2)
                .multiply(hmdMatrix)
                .toArray(frameData.rightViewMatrix);

              system.GetProjectionMatrix(1, depthNear, depthFar, localFloat32Array4);
              _normalizeMatrixArray(localFloat32Array4);
              frameData.rightProjectionMatrix.set(localFloat32Array4);

              // build stage parameters
              system.GetSeatedZeroPoseToStandingAbsoluteTrackingPose(localFloat32Array4);
              _normalizeMatrixArray(localFloat32Array4);
              stageParameters.sittingToStandingTransform.set(localFloat32Array4);

              // build gamepads data
              system.GetControllerState(0, localGamepadArray);
              if (!isNaN(localGamepadArray[0])) {
                leftGamepad.buttons[0].pressed = localGamepadArray[4] !== 0; // pad
                leftGamepad.buttons[1].pressed = localGamepadArray[5] !== 0; // trigger
                leftGamepad.buttons[2].pressed = localGamepadArray[3] !== 0; // grip
                leftGamepad.buttons[3].pressed = localGamepadArray[2] !== 0; // menu

                leftGamepad.buttons[0].touched = localGamepadArray[9] !== 0; // pad
                leftGamepad.buttons[1].touched = localGamepadArray[10] !== 0; // trigger
                leftGamepad.buttons[2].touched = localGamepadArray[8] !== 0; // grip
                leftGamepad.buttons[3].touched = localGamepadArray[7] !== 0; // menu

                leftGamepad.axes[0] = localGamepadArray[11];
                leftGamepad.axes[1] = localGamepadArray[12];

                gamepads[0] = leftGamepad;
              } else {
                gamepads[0] = null;
              }

              system.GetControllerState(1, localGamepadArray);
              if (!isNaN(localGamepadArray[0])) {
                rightGamepad.buttons[0].pressed = localGamepadArray[4] !== 0; // pad
                rightGamepad.buttons[1].pressed = localGamepadArray[5] !== 0; // trigger
                rightGamepad.buttons[2].pressed = localGamepadArray[3] !== 0; // grip
                rightGamepad.buttons[3].pressed = localGamepadArray[2] !== 0; // menu

                rightGamepad.buttons[0].touched = localGamepadArray[9] !== 0; // pad
                rightGamepad.buttons[1].touched = localGamepadArray[10] !== 0; // trigger
                rightGamepad.buttons[2].touched = localGamepadArray[8] !== 0; // grip
                rightGamepad.buttons[3].touched = localGamepadArray[7] !== 0; // menu

                rightGamepad.axes[0] = localGamepadArray[11];
                rightGamepad.axes[1] = localGamepadArray[12];

                gamepads[1] = rightGamepad;
              } else {
                gamepads[1] = null;
              }

              // update vr frame
              window.updateVrFrame({
                depthNear: 0.1,
                depthFar: 1000.0,
                renderWidth,
                renderHeight,
                frameData,
                stageParameters,
                gamepads,
              });
            }

            /* // bind framebuffer for rendering
            for (let i = 0; i < contexts.length; i++) {
              const context = contexts[i];
              if (compositor) {
                nativeWindow.bindFrameBuffer(msFbo); // XXX switch to context first
              } else {
                nativeWindow.bindFrameBuffer(0);
              }
            } */

            // poll for window events
            nativeWindow.pollEvents({
              emit: (type, data) => {
                // console.log(type, data);

                switch (type) {
                  case 'framebufferResize': {
                    const {width, height} = data;
                    innerWidth = width;
                    innerHeight = height;

                    if (window) {
                      window.innerWidth = innerWidth;
                      window.innerHeight = innerHeight;
                      window.emit('resize');
                    }
                    break;
                  }
                  case 'keydown':
                  case 'keyup':
                  case 'keypress':
                  case 'mousedown':
                  case 'mouseup':
                  case 'click': {
                    data.preventDefault = nop;
                    data.preventStopPropagation = nop;
                    data.preventStopImmediatePropagation = nop;

                    window.emit(type, data);
                    break;
                  }
                  case 'mousemove': {
                    data.preventDefault = nop;
                    data.preventStopPropagation = nop;
                    data.preventStopImmediatePropagation = nop;

                    const context = contexts.find(context => _windowHandleEquals(context[windowHandleSymbol], data.windowHandle));
                    if (window.document.pointerLockElement === context[canvasSymbol]) {
                      data.movementX = data.pageX - (window.innerWidth / window.devicePixelRatio / 2);
                      data.movementY = data.pageY - (window.innerHeight / window.devicePixelRatio / 2);

                      nativeWindow.setCursorPosition(context[windowHandleSymbol], window.innerWidth / 2, window.innerHeight / 2);
                    }

                    window.emit(type, data);
                    break;
                  }
                  case 'quit': {
                    nativeWindow.destroy(data.windowHandle);
                    contexts.splice(contexts.findIndex(context => _windowHandleEquals(context[windowHandleSymbol], data.windowHandle)), 1);
                    break;
                  }
                }
              },
            });

            // update media frames
            nativeVideo.Video.updateAll();

            // trigger requestAnimationFrame
            window.tickAnimationFrame();

            // submit frame
            for (let i = 0; i < contexts.length; i++) {
              const context = contexts[i];
              if (compositor) {
                nativeWindow.blitFrameBuffer(msFbo, fbo, renderWidth * 2, renderHeight, renderWidth * 2, renderHeight); // XXX switch to context first
                compositor.Submit(texture);

                nativeWindow.blitFrameBuffer(fbo, 0, renderWidth * 2, renderHeight, window.innerWidth, window.innerHeight);
              }
              nativeWindow.swapBuffers(context[windowHandleSymbol]);
            }

            // wait for next frame
            const now = Date.now();
            setTimeout(_recurse, Math.min(Math.max(FRAME_TIME_MAX - (now - lastFrameTime), FRAME_TIME_MIN), FRAME_TIME_MAX));
            lastFrameTime = now;
          };
          _recurse();
        });
    } else {
      const window = exokit();
      if (!vm.isContext(window)) {
        vm.createContext(window);
      }

      const _getPrompt = os.platform() !== 'win32' ?
        () => `[${emojis[Math.floor(Math.random() * emojis.length)]}] `
      :
        () => '[x] ';

      let lastUnderscore = window._;
      const replEval = (cmd, context, filename, callback) => {
        let result, err = null, match;

        if (/^\s*<(?:\!\-*)?[a-z]/i.test(cmd)) {
          const e = window.document.createElement('div');
          e.innerHTML = cmd;
          if (e.childNodes.length === 0) {
            result = undefined;
          } else if (e.childNodes.length === 1) {
            result = e.childNodes[0];
          } else {
            result = e.childNodes;
          }
        } else if (match = cmd.match(/^\s*(?:const|var|let)?\s*([a-z][a-z0-9]*)\s*=\s*(<(?:\!\-*)?[a-z].*)$/im)) {
          const e = window.document.createElement('div');
          e.innerHTML = match[2];
          if (e.childNodes.length === 0) {
            result = undefined;
          } else if (e.childNodes.length === 1) {
            result = e.childNodes[0];
          } else {
            result = e.childNodes;
          }
          window[match[1]] = result;
        } else {
          try {
            result = vm.runInContext(cmd, window, {filename});
          } catch(e) {
            err = e;
          }
        }

        if (!err) {
          if (window._ === lastUnderscore) {
            window._ = result;
            lastUnderscore = result;
          }
          if (result !== undefined) {
            r.setPrompt(_getPrompt());
          }
        } else {
          if (err.name === 'SyntaxError') {
            err = new repl.Recoverable(err);
          }
        }
        callback(err, result);
      };
      const r = repl.start({
        prompt: _getPrompt(),
        eval: replEval,
      });
      r.defineCommand('go', {
        help: 'Navigate to <url>',
        action(url) {
          window.location.href = url;
          this.clearBufferedCommand();
          this.displayPrompt();
        }
      });
      replHistory(r, path.join(process.env.HOME || process.cwd(), '.exokit_history'));
    }
  };

  _prepare()
    .then(() => _start());
}

process.on('uncaughtException', err => {
  console.warn(err.stack);
});
process.on('unhandledRejection', err => {
  console.warn(err.stack);
});
