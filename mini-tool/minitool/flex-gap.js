// Chrome 61 基线：实测 Flexbox gap 布局行为（语法检测不可靠，grid-gap 支持不代表 flex gap 生效）。
// 支持时给根元素加 .flex-gap，CSS 据此清除 margin 基线、由 gap 接管间距。检测一次，不在渲染循环中重复测量。
(function () {
  var flex = document.createElement('div');
  flex.style.cssText = 'position:absolute;visibility:hidden;display:flex;flex-direction:column;row-gap:1px';
  flex.appendChild(document.createElement('div'));
  flex.appendChild(document.createElement('div'));
  (document.body || document.documentElement).appendChild(flex);
  if (flex.scrollHeight === 1) document.documentElement.classList.add('flex-gap');
  flex.parentNode.removeChild(flex);
})();
