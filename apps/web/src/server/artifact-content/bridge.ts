/**
 * The page side of the artifact bridge, as a string. The Worker injects
 * `<script src="_hm/bridge.js">` first in `<head>` of every HTML artifact page
 * and serves this source there. It cannot read files at runtime, so the script
 * lives here. Keep it free of backticks, dollar-brace and backslashes so the
 * template literal needs no escaping.
 *
 * The page runs in an opaque origin (`sandbox="allow-scripts allow-forms"`).
 * The script gives it in-memory localStorage and sessionStorage, performs the
 * MCP Apps `ui/initialize` handshake with the viewer frame, and then talks to
 * the frame over the MessagePort the frame hands back. Spec:
 * docs/v3/artifacts-prd.md, "Hosting and isolation" and "Bridge".
 */
export const BRIDGE_JS = `(function () {
  "use strict";

  var PROTOCOL_VERSION = "2026-01-26";
  var RETRY_MS = 250;
  var MAX_TRIES = 40;

  // The real Storage objects throw SecurityError in an opaque origin.
  function installStorage(name) {
    try {
      var map = new Map();
      var methods = {
        clear: function () {
          map.clear();
        },
        getItem: function (key) {
          var k = String(key);
          return map.has(k) ? map.get(k) : null;
        },
        key: function (index) {
          var keys = Array.from(map.keys());
          var i = Number(index);
          return Number.isInteger(i) && i >= 0 && i < keys.length
            ? keys[i]
            : null;
        },
        removeItem: function (key) {
          map.delete(String(key));
        },
        setItem: function (key, value) {
          map.set(String(key), String(value));
        },
      };
      var isMethod = function (prop) {
        return Object.prototype.hasOwnProperty.call(methods, prop);
      };
      var store = new Proxy({}, {
        deleteProperty: function (_target, prop) {
          if (typeof prop === "string") {
            map.delete(prop);
          }
          return true;
        },
        get: function (_target, prop) {
          if (typeof prop !== "string") {
            return undefined;
          }
          if (prop === "length") {
            return map.size;
          }
          if (isMethod(prop)) {
            return methods[prop];
          }
          return map.has(prop) ? map.get(prop) : undefined;
        },
        getOwnPropertyDescriptor: function (_target, prop) {
          if (typeof prop === "string" && map.has(prop)) {
            return {
              configurable: true,
              enumerable: true,
              value: map.get(prop),
              writable: true,
            };
          }
          return undefined;
        },
        has: function (_target, prop) {
          return (
            typeof prop === "string" &&
            (prop === "length" || isMethod(prop) || map.has(prop))
          );
        },
        ownKeys: function () {
          return Array.from(map.keys());
        },
        set: function (_target, prop, value) {
          if (typeof prop === "string") {
            map.set(prop, String(value));
          }
          return true;
        },
      });
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () {
          return store;
        },
      });
    } catch (_error) {
      // The page keeps whatever storage it had.
    }
  }

  installStorage("localStorage");
  installStorage("sessionStorage");

  function isHttpUrl(value) {
    try {
      var protocol = new URL(String(value)).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch (_error) {
      return false;
    }
  }

  // The script lives at <content folder>/_hm/bridge.js.
  var contentFolder = null;
  try {
    contentFolder = new URL("../", document.currentScript.src).href;
  } catch (_error) {
    contentFolder = null;
  }

  // The viewer sets the iframe's name attribute to a nonce, and accepts a port
  // only from a page that sends it back. window.name survives every
  // navigation in the same tab, so the next page of the artifact has it too. It
  // is defence in depth, not a secret: this page's own scripts can read it.
  // The grants are what limit a page. A page that
  // assigns window.name itself loses the nonce, and the frame blanks.
  function readNonce() {
    try {
      var name = window.name;
      return typeof name === "string" && name !== "" ? name : null;
    } catch (_error) {
      return null;
    }
  }

  // Taken once, before any page script can reassign it.
  var parentWindow = window.parent;
  var nonce = readNonce();
  var port = null;
  var initResult = null;
  var nextId = 2;
  var pending = new Map();
  var resolveReady = function () {};
  var ready = new Promise(function (resolve) {
    resolveReady = resolve;
  });

  function request(method, params) {
    return new Promise(function (resolve, reject) {
      if (!port) {
        reject(new Error("Harbourmaster bridge is not connected"));
        return;
      }
      var id = nextId;
      nextId += 1;
      var message = { id: id, jsonrpc: "2.0", method: method };
      if (params !== undefined) {
        message.params = params;
      }
      pending.set(id, { reject: reject, resolve: resolve });
      try {
        port.postMessage(message);
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function openLink(url) {
    if (!isHttpUrl(url)) {
      return Promise.reject(
        new Error("openLink needs an http or https URL")
      );
    }
    return request("ui/open-link", { url: String(url) });
  }

  // Waits for the handshake, so a call made early still goes out once connected.
  function call(method, params) {
    return ready.then(function () {
      return request(method, params);
    });
  }

  function scopeOf(scope) {
    return scope === undefined ? "viewer" : scope;
  }

  function noValue() {}

  var tools = Object.freeze({
    call: function (name, args) {
      var params = { name: String(name) };
      if (args !== undefined) {
        params.arguments = args;
      }
      return call("tools/call", params);
    },
  });

  var storage = Object.freeze({
    delete: function (key, scope) {
      return call("storage/delete", {
        key: String(key),
        scope: scopeOf(scope),
      }).then(noValue);
    },
    get: function (key, scope) {
      return call("storage/get", {
        key: String(key),
        scope: scopeOf(scope),
      }).then(function (result) {
        return result.value;
      });
    },
    list: function (prefix, scope) {
      var params = { scope: scopeOf(scope) };
      if (prefix !== undefined) {
        params.prefix = String(prefix);
      }
      return call("storage/list", params).then(function (result) {
        return result.keys;
      });
    },
    set: function (key, value, scope) {
      return call("storage/set", {
        key: String(key),
        scope: scopeOf(scope),
        value: value,
      }).then(noValue);
    },
  });

  function sendMessage(text) {
    return call("ui/message", {
      content: [{ text: String(text), type: "text" }],
      role: "user",
    }).then(noValue);
  }

  // This toolbar is offered only by a member viewer, never link/preview frames.
  // DOM descriptions remain untrusted data. The host supplies artifact/version ids.
  ready.then(function () {
    if (!initResult || !initResult.elementAsk || !document.createElement) {
      return;
    }
    var host = document.createElement("div");
    host.setAttribute("data-hm-element-ask", "");
    host.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:2147483647";
    var root = host.attachShadow({ mode: "open" });
    var box = document.createElement("div");
    box.style.cssText = "background:white;color:#111;border:1px solid #aaa;border-radius:8px;padding:12px;max-width:320px;font:14px system-ui;box-shadow:0 2px 12px #0003";
    var pick = document.createElement("button");
    pick.textContent = "Select element to ask agent";
    var label = document.createElement("p");
    label.setAttribute("role", "status");
    var question = document.createElement("textarea");
    question.setAttribute("aria-label", "Question about selected element");
    question.placeholder = "Ask about the selected element";
    question.maxLength = 8000;
    question.style.cssText = "display:block;width:280px;min-height:64px;margin:8px 0";
    var send = document.createElement("button");
    send.textContent = "Ask agent";
    send.disabled = true;
    box.append(pick, label, question, send);
    root.append(box);
    document.body.append(host);
    var picking = false;
    var selected = null;
    var snapshot = null;
    var requestId = null;
    var fullHtml = null;
    var highlight = document.createElement("div");
    highlight.style.cssText = "position:fixed;pointer-events:none;border:2px solid #2563eb;box-sizing:border-box;display:none";
    root.append(highlight);
    var busy = false;
    function clear() {
      highlight.style.display = "none";
      host.style.pointerEvents = "";
      selected = null;
      snapshot = null;
      requestId = null;
      send.disabled = true;
    }
    function selectorOf(element) {
      var parts = [];
      while (element && element.nodeType === 1) {
        var index = 1;
        var sibling = element.previousElementSibling;
        while (sibling) { index += 1; sibling = sibling.previousElementSibling; }
        parts.unshift(element.tagName.toLowerCase() + ":nth-child(" + index + ")");
        element = element.parentElement;
      }
      return parts.join(" > ");
    }
    function describe(element) {
      var path = new URL(window.location.href).pathname;
      var base = new URL(contentFolder).pathname;
      if (path.indexOf(base) !== 0) { throw new Error("Select a page in this artifact"); }
      return {
        html: element.outerHTML.slice(0, 4096),
        path: decodeURIComponent(path.slice(base.length)),
        selector: selectorOf(element),
        tag: element.tagName.toLowerCase(),
        text: (element.textContent || "").slice(0, 2048),
      };
    }
    pick.addEventListener("click", function () {
      if (busy) { return; }
      clear();
      picking = true;
      host.style.pointerEvents = "none";
      question.style.display = "none";
      send.hidden = true;
      label.textContent = "Click an element in the page. Escape cancels.";
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { picking = false; clear(); label.textContent = "Selection cleared"; }
    }, true);
    document.addEventListener("click", function (event) {
      if (!picking || event.composedPath().indexOf(host) !== -1) { return; }
      event.preventDefault();
      event.stopImmediatePropagation();
      var target = event.target;
      if (!target || target.nodeType !== 1 || target === document.body || target === document.documentElement) { return; }
      try {
        selected = target;
        snapshot = describe(selected);
        requestId = crypto.randomUUID();
        fullHtml = selected.outerHTML;
        var rect = selected.getBoundingClientRect();
        highlight.style.left = rect.left + "px";
        highlight.style.top = rect.top + "px";
        highlight.style.width = rect.width + "px";
        highlight.style.height = rect.height + "px";
        highlight.style.display = "block";
        host.style.pointerEvents = "";
        question.style.display = "block";
        send.hidden = false;
        picking = false;
        send.disabled = false;
        label.textContent = "Selected " + snapshot.tag + ": " + snapshot.text.slice(0, 100);
      } catch (error) { clear(); label.textContent = error.message; }
    }, true);
    question.addEventListener("input", function () {
      if (selected && !busy) { requestId = crypto.randomUUID(); }
    });
    send.addEventListener("click", function () {
      if (busy || !selected || !question.value.trim()) { return; }
      var current = describe(selected);
      if (!selected.isConnected || selected.outerHTML !== fullHtml || JSON.stringify(current) !== JSON.stringify(snapshot)) {
        clear(); label.textContent = "Element changed. Select it again."; return;
      }
      busy = true;
      question.disabled = true;
      send.disabled = true;
      label.textContent = "Asking agent…";
      call("ui/message", {
        content: [{ text: question.value, type: "text" }],
        element: snapshot,
        requestId: requestId,
        role: "user",
      }).then(function () {
        clear(); question.value = ""; label.textContent = "Sent to the artifact agent thread";
      }).catch(function (error) {
        label.textContent = error.message;
        send.disabled = false;
      }).finally(function () { busy = false; question.disabled = false; });
    });
  }).catch(function () {});

  function handlePortMessage(event) {
    try {
      var message = event.data;
      if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
        return;
      }
      var entry = pending.get(message.id);
      if (!entry) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        var text =
          typeof message.error.message === "string"
            ? message.error.message
            : "Harbourmaster bridge request failed";
        var failure = new Error(text);
        failure.code = message.error.code;
        entry.reject(failure);
        return;
      }
      entry.resolve(message.result);
    } catch (_error) {
      // A bad message from the frame must not reach the page.
    }
  }

  var sizeQueued = false;

  function sendSize() {
    try {
      var rect = document.documentElement.getBoundingClientRect();
      port.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height: Math.ceil(rect.height), width: Math.ceil(rect.width) },
      });
    } catch (_error) {
      // Size reports are best effort.
    }
  }

  function queueSize() {
    if (sizeQueued) {
      return;
    }
    sizeQueued = true;
    var run = function () {
      sizeQueued = false;
      sendSize();
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
    } else {
      run();
    }
  }

  function connect(result, messagePort) {
    port = messagePort;
    initResult = result;
    port.onmessage = handlePortMessage;
    try {
      port.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/initialized",
      });
    } catch (_error) {
      // The frame is gone; requests will reject.
    }
    sendSize();
    try {
      if (typeof window.ResizeObserver === "function") {
        new window.ResizeObserver(queueSize).observe(document.documentElement);
      }
    } catch (_error) {
      // Without an observer the frame keeps the first size.
    }
    resolveReady(result);
  }

  function isInitializeResponse(data) {
    return (
      !!data &&
      typeof data === "object" &&
      data.jsonrpc === "2.0" &&
      data.id === 1 &&
      !!data.result &&
      typeof data.result === "object" &&
      "theme" in data.result &&
      "viewer" in data.result &&
      "version" in data.result
    );
  }

  function startHandshake() {
    var tries = 0;
    var timer = null;
    var initParams = {
      appInfo: { name: "harbourmaster-bridge", version: "1" },
      protocolVersion: PROTOCOL_VERSION,
    };
    if (nonce !== null) {
      initParams.nonce = nonce;
    }

    window.addEventListener("message", function (event) {
      try {
        if (port || event.source !== parentWindow) {
          return;
        }
        if (!isInitializeResponse(event.data)) {
          return;
        }
        var messagePort = event.ports && event.ports[0];
        if (!messagePort) {
          return;
        }
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        connect(event.data.result, messagePort);
      } catch (_error) {
        // Ignore anything that does not fit.
      }
    });

    var attempt = function () {
      timer = null;
      if (port) {
        return;
      }
      if (tries >= MAX_TRIES) {
        resolveReady(null);
        return;
      }
      tries += 1;
      try {
        parentWindow.postMessage(
          {
            id: 1,
            jsonrpc: "2.0",
            method: "ui/initialize",
            params: initParams,
          },
          "*"
        );
      } catch (_error) {
        // Try again on the next tick.
      }
      timer = setTimeout(attempt, RETRY_MS);
    };
    attempt();
  }

  try {
    if (parentWindow === window) {
      resolveReady(null);
    } else {
      startHandshake();
    }
  } catch (_error) {
    resolveReady(null);
  }

  function field(name) {
    return initResult ? initResult[name] : null;
  }

  try {
    window.harbourmaster = Object.freeze({
      get theme() {
        return field("theme");
      },
      get version() {
        return field("version");
      },
      get viewer() {
        return field("viewer");
      },
      openLink: openLink,
      ready: ready,
      request: request,
      sendMessage: sendMessage,
      storage: storage,
      tools: tools,
    });
  } catch (_error) {
    // The page keeps running without the API.
  }

  function findAnchor(target) {
    var node = target;
    while (node) {
      if (
        typeof node.tagName === "string" &&
        node.tagName.toUpperCase() === "A" &&
        typeof node.href === "string" &&
        node.href !== ""
      ) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  if (contentFolder !== null) {
    try {
      document.addEventListener(
        "click",
        function (event) {
          try {
            if (!port) {
              return;
            }
            var anchor = findAnchor(event.target);
            if (!anchor) {
              return;
            }
            var href = new URL(anchor.href).href;
            if (!isHttpUrl(href) || href.indexOf(contentFolder) === 0) {
              return;
            }
            event.preventDefault();
            openLink(href).catch(function () {});
          } catch (_error) {
            // Let the browser handle the click.
          }
        },
        true
      );
    } catch (_error) {
      // Links keep their default behaviour.
    }
  }
})();
`;
