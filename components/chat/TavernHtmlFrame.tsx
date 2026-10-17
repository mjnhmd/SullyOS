import React, { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface TavernHtmlFrameProps {
    html: string;
    onSendChoice?: (text: string) => void;
    className?: string;
}

/**
 * Determine whether a code block or HTML snippet is an interactive/rich Tavern HTML document
 * (e.g. <!DOCTYPE html>, <html>, or contains <style>/<script>).
 */
export function isTavernRichHtmlBlock(code: string): boolean {
    const trimmed = String(code || '').trim();
    if (!trimmed) return false;
    if (/^(?:<!--[\s\S]*?-->\s*)*<!DOCTYPE\s+html/i.test(trimmed)) return true;
    if (/^(?:<!--[\s\S]*?-->\s*)*<(?:html|head|body)[\s>]/i.test(trimmed)) return true;
    if (/^(?:<!--[\s\S]*?-->\s*)*<(?:div|span|style|script|section|main|article|iframe)\b/i.test(trimmed) && /<(?:style|script|body|iframe)\b/i.test(trimmed)) return true;
    return false;
}

function buildSandboxedDocument(rawHtml: string, frameId: string): string {
    const trimmed = String(rawHtml || '').trim();
    const bridgeScript = `<script>
(function(){
  var FRAME_ID = ${JSON.stringify(frameId)};
  try {
    var testLs = window.localStorage;
    if (testLs) testLs.getItem("__test__");
  } catch (e) {
    var mem = {};
    var fakeStorage = {
      getItem: function(k){ return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      setItem: function(k, v){ mem[k] = String(v); },
      removeItem: function(k){ delete mem[k]; },
      clear: function(){ mem = {}; }
    };
    try { Object.defineProperty(window, "localStorage", { value: fakeStorage, configurable: true }); } catch (err) {}
    try { Object.defineProperty(window, "sessionStorage", { value: fakeStorage, configurable: true }); } catch (err) {}
  }
  if (typeof window.$ === "undefined" && typeof window.jQuery === "undefined") {
    var miniJq = function(sel) {
      var els = typeof sel === "string" ? Array.prototype.slice.call(document.querySelectorAll(sel)) : (sel ? [sel] : []);
      return {
        load: function(url, cb) {
          fetch(url).then(function(r){ return r.text(); }).then(function(html){
            els.forEach(function(el){
              el.innerHTML = html;
              var scripts = Array.prototype.slice.call(el.querySelectorAll("script"));
              scripts.forEach(function(oldScript){
                var newScript = document.createElement("script");
                Array.prototype.slice.call(oldScript.attributes).forEach(function(attr){
                  newScript.setAttribute(attr.name, attr.value);
                });
                newScript.textContent = oldScript.textContent;
                oldScript.parentNode.replaceChild(newScript, oldScript);
              });
            });
            if (typeof cb === "function") cb(html, "success");
            setTimeout(reportHeight, 100);
            setTimeout(reportHeight, 500);
          }).catch(function(err){ console.warn("[TavernHtmlFrame] $.load failed:", err); });
          return this;
        },
        html: function(v) {
          if (v === undefined) return els[0] ? els[0].innerHTML : "";
          els.forEach(function(el){ el.innerHTML = v; });
          return this;
        },
        on: function(ev, fn) {
          els.forEach(function(el){ el.addEventListener(ev, fn); });
          return this;
        }
      };
    };
    window.$ = window.jQuery = miniJq;
  }
  window.triggerSlash = window.triggerSlash || function(cmd) {
    var text = String(cmd || "").replace(/^\/(?:send|echo)\s+/i, "").trim();
    if (text) window.parent.postMessage({ __sullyTavernAction: true, frameId: FRAME_ID, text: text }, "*");
  };
  var lastHeight = 0;
  function reportHeight() {
    try {
      var body = document.body;
      var docEl = document.documentElement;
      if (!body || !docEl) return;
      var h = Math.max(
        body.scrollHeight || 0,
        body.offsetHeight || 0,
        docEl.scrollHeight || 0,
        docEl.offsetHeight || 0
      );
      if (h > 0 && Math.abs(h - lastHeight) > 2) {
        lastHeight = h;
        window.parent.postMessage({ __sullyTavernFrameHeight: true, frameId: FRAME_ID, height: h }, "*");
      }
    } catch (e) {}
  }
  window.addEventListener("load", function() {
    reportHeight();
    setTimeout(reportHeight, 120);
    setTimeout(reportHeight, 450);
    setTimeout(reportHeight, 1200);
  });
  if (typeof ResizeObserver !== "undefined") {
    try {
      var ro = new ResizeObserver(reportHeight);
      if (document.documentElement) ro.observe(document.documentElement);
      window.addEventListener("DOMContentLoaded", function() {
        if (document.body) ro.observe(document.body);
      });
    } catch (e) {}
  }
  document.addEventListener("click", function() {
    setTimeout(reportHeight, 60);
    setTimeout(reportHeight, 320);
  }, true);
})();
<\/script>`;

    if (/<!DOCTYPE\s+html|<html[\s>]/i.test(trimmed)) {
        if (/<head[\s>]/i.test(trimmed)) {
            return trimmed.replace(/<head(\b[^>]*)>/i, `<head$1>${bridgeScript}`);
        }
        return `${bridgeScript}${trimmed}`;
    }

    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${bridgeScript}<style>html,body{margin:0;padding:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}</style></head><body>${trimmed}</body></html>`;
}

export const TavernHtmlFrame: React.FC<TavernHtmlFrameProps> = ({
    html,
    onSendChoice,
    className = '',
}) => {
    const reactId = useId();
    const frameId = useMemo(() => `tavern-frame-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`, [reactId]);
    const [height, setHeight] = useState<number>(360);
    const onSendRef = useRef(onSendChoice);
    onSendRef.current = onSendChoice;

    const srcDoc = useMemo(() => buildSandboxedDocument(html, frameId), [html, frameId]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const data = event.data;
            if (!data || typeof data !== 'object' || data.frameId !== frameId) return;
            if (data.__sullyTavernFrameHeight && typeof data.height === 'number') {
                const clamped = Math.max(80, Math.min(3600, Math.ceil(data.height) + 4));
                setHeight(clamped);
            } else if (data.__sullyTavernAction && typeof data.text === 'string' && data.text.trim()) {
                onSendRef.current?.(data.text.trim());
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [frameId]);

    return (
        <div
            className={`sully-tavern-html-frame w-full max-w-full overflow-hidden rounded-2xl my-2 ${className}`}
            onPointerDown={e => e.stopPropagation()}
            onPointerMove={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
        >
            <iframe
                title={frameId}
                srcDoc={srcDoc}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                className="block w-full border-0 bg-transparent transition-[height] duration-150"
                style={{ height: `${height}px` }}
            />
        </div>
    );
};

export default TavernHtmlFrame;
