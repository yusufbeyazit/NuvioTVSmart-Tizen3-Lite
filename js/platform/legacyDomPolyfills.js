/**
 * Lightweight DOM & Web API polyfills for Chromium 47 (Samsung Tizen 3.0).
 * core-js only polyfills ECMAScript builtins; these cover missing Web/DOM APIs
 * such as URLSearchParams, URL.prototype.searchParams, NodeList.forEach, and
 * Node.prototype.isConnected.
 */
(function installLegacyDomPolyfills(root) {
  if (typeof root.globalThis === "undefined") {
    root.globalThis = root;
  }

  if (typeof root.Node === "undefined") {
    root.Node = { ELEMENT_NODE: 1, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 };
  }

  if (
    typeof root.NodeList !== "undefined" &&
    root.NodeList.prototype &&
    typeof root.NodeList.prototype.forEach !== "function"
  ) {
    root.NodeList.prototype.forEach = Array.prototype.forEach;
  }

  if (
    typeof root.HTMLCollection !== "undefined" &&
    root.HTMLCollection.prototype &&
    typeof root.HTMLCollection.prototype.forEach !== "function"
  ) {
    root.HTMLCollection.prototype.forEach = Array.prototype.forEach;
  }

  if (
    typeof root.Node !== "undefined" &&
    root.Node.prototype &&
    !("isConnected" in root.Node.prototype)
  ) {
    Object.defineProperty(root.Node.prototype, "isConnected", {
      configurable: true,
      enumerable: true,
      get: function isConnected() {
        var doc = this.ownerDocument || root.document;
        if (!doc) return false;
        if (this === doc) return true;
        var rootNode = doc.documentElement || doc;
        return typeof rootNode.contains === "function" ? rootNode.contains(this) : false;
      }
    });
  }

  if (typeof root.Element !== "undefined" && root.Element.prototype) {
    var ep = root.Element.prototype;
    if (!ep.matches) {
      ep.matches = ep.webkitMatchesSelector || ep.msMatchesSelector || ep.mozMatchesSelector;
    }
    if (!ep.closest) {
      ep.closest = function closest(selector) {
        var el = this;
        while (el && el.nodeType === 1) {
          if (el.matches(selector)) return el;
          el = el.parentElement || el.parentNode;
        }
        return null;
      };
    }
    if (!ep.remove) {
      ep.remove = function remove() {
        if (this.parentNode) {
          this.parentNode.removeChild(this);
        }
      };
    }

    var toFragment = function (args, doc) {
      var frag = (doc || root.document).createDocumentFragment();
      for (var i = 0; i < args.length; i++) {
        var item = args[i];
        frag.appendChild(
          item && typeof item === "object" && "nodeType" in item
            ? item
            : (doc || root.document).createTextNode(String(item))
        );
      }
      return frag;
    };

    if (!ep.append) {
      ep.append = function append() {
        this.appendChild(toFragment(arguments, this.ownerDocument));
      };
    }
    if (!ep.prepend) {
      ep.prepend = function prepend() {
        this.insertBefore(toFragment(arguments, this.ownerDocument), this.firstChild);
      };
    }
    if (!ep.before) {
      ep.before = function before() {
        if (this.parentNode) {
          this.parentNode.insertBefore(toFragment(arguments, this.ownerDocument), this);
        }
      };
    }
    if (!ep.after) {
      ep.after = function after() {
        if (this.parentNode) {
          this.parentNode.insertBefore(
            toFragment(arguments, this.ownerDocument),
            this.nextSibling
          );
        }
      };
    }
    if (!ep.replaceWith) {
      ep.replaceWith = function replaceWith() {
        if (this.parentNode) {
          this.parentNode.replaceChild(toFragment(arguments, this.ownerDocument), this);
        }
      };
    }
  }

  if (typeof root.URLSearchParams !== "function") {
    var decodeComponent = function (str) {
      return decodeURIComponent(String(str).replace(/\+/g, " "));
    };
    var encodeComponent = function (str) {
      return encodeURIComponent(String(str)).replace(/%20/g, "+");
    };

    var URLSearchParamsPolyfill = function URLSearchParams(init) {
      this._entries = [];
      if (init === undefined || init === null) return;
      if (typeof init === "string") {
        var query = init.charAt(0) === "?" ? init.slice(1) : init;
        if (!query) return;
        var pairs = query.split("&");
        for (var i = 0; i < pairs.length; i++) {
          var part = pairs[i];
          if (!part) continue;
          var eqIndex = part.indexOf("=");
          if (eqIndex === -1) {
            this._entries.push([decodeComponent(part), ""]);
          } else {
            this._entries.push([
              decodeComponent(part.slice(0, eqIndex)),
              decodeComponent(part.slice(eqIndex + 1))
            ]);
          }
        }
      } else if (Array.isArray(init)) {
        for (var j = 0; j < init.length; j++) {
          var pair = init[j];
          if (pair && pair.length >= 2) {
            this._entries.push([String(pair[0]), String(pair[1])]);
          }
        }
      } else if (init instanceof URLSearchParamsPolyfill) {
        for (var k = 0; k < init._entries.length; k++) {
          this._entries.push([init._entries[k][0], init._entries[k][1]]);
        }
      } else if (typeof init === "object") {
        var keys = Object.keys(init);
        for (var m = 0; m < keys.length; m++) {
          this._entries.push([String(keys[m]), String(init[keys[m]])]);
        }
      }
    };

    URLSearchParamsPolyfill.prototype._notify = function () {
      if (typeof this._onChange === "function") {
        this._onChange(this.toString());
      }
    };

    URLSearchParamsPolyfill.prototype.append = function (name, value) {
      this._entries.push([String(name), String(value)]);
      this._notify();
    };

    URLSearchParamsPolyfill.prototype.delete = function (name) {
      var target = String(name);
      this._entries = this._entries.filter(function (entry) {
        return entry[0] !== target;
      });
      this._notify();
    };

    URLSearchParamsPolyfill.prototype.get = function (name) {
      var target = String(name);
      for (var i = 0; i < this._entries.length; i++) {
        if (this._entries[i][0] === target) {
          return this._entries[i][1];
        }
      }
      return null;
    };

    URLSearchParamsPolyfill.prototype.getAll = function (name) {
      var target = String(name);
      var result = [];
      for (var i = 0; i < this._entries.length; i++) {
        if (this._entries[i][0] === target) {
          result.push(this._entries[i][1]);
        }
      }
      return result;
    };

    URLSearchParamsPolyfill.prototype.has = function (name) {
      var target = String(name);
      for (var i = 0; i < this._entries.length; i++) {
        if (this._entries[i][0] === target) {
          return true;
        }
      }
      return false;
    };

    URLSearchParamsPolyfill.prototype.set = function (name, value) {
      var target = String(name);
      var val = String(value);
      var found = false;
      var next = [];
      for (var i = 0; i < this._entries.length; i++) {
        if (this._entries[i][0] === target) {
          if (!found) {
            next.push([target, val]);
            found = true;
          }
        } else {
          next.push(this._entries[i]);
        }
      }
      if (!found) {
        next.push([target, val]);
      }
      this._entries = next;
      this._notify();
    };

    URLSearchParamsPolyfill.prototype.sort = function () {
      this._entries.sort(function (a, b) {
        if (a[0] < b[0]) return -1;
        if (a[0] > b[0]) return 1;
        return 0;
      });
      this._notify();
    };

    URLSearchParamsPolyfill.prototype.toString = function () {
      return this._entries
        .map(function (entry) {
          return encodeComponent(entry[0]) + "=" + encodeComponent(entry[1]);
        })
        .join("&");
    };

    URLSearchParamsPolyfill.prototype.forEach = function (callback, thisArg) {
      for (var i = 0; i < this._entries.length; i++) {
        callback.call(thisArg, this._entries[i][1], this._entries[i][0], this);
      }
    };

    URLSearchParamsPolyfill.prototype.entries = function () {
      return this._entries.slice()[Symbol.iterator]();
    };

    URLSearchParamsPolyfill.prototype.keys = function () {
      return this._entries
        .map(function (entry) {
          return entry[0];
        })
        [Symbol.iterator]();
    };

    URLSearchParamsPolyfill.prototype.values = function () {
      return this._entries
        .map(function (entry) {
          return entry[1];
        })
        [Symbol.iterator]();
    };

    if (typeof Symbol !== "undefined" && Symbol.iterator) {
      URLSearchParamsPolyfill.prototype[Symbol.iterator] =
        URLSearchParamsPolyfill.prototype.entries;
    }

    root.URLSearchParams = URLSearchParamsPolyfill;
  }

  if (typeof root.URL === "function" && root.URL.prototype && !("searchParams" in root.URL.prototype)) {
    Object.defineProperty(root.URL.prototype, "searchParams", {
      configurable: true,
      enumerable: true,
      get: function getSearchParams() {
        var urlObj = this;
        var params = new root.URLSearchParams(urlObj.search || "");
        params._onChange = function (serialized) {
          urlObj.search = serialized ? "?" + serialized : "";
        };
        return params;
      }
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : self);
