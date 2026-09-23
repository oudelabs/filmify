'use strict';
// 固定3:4炭黑画布，200px照片展位随机错落。调用方持有种子，预览/两种静态/录制共用布局。
// 显影同步叠化，左配方、右Logo全程常显；照片完整fit，不裁剪。
// Canvas2D + MediaRecorder only; no camera/mic/network.
window.FilmifyCollageGrid=(function(){
  var W=1200,H=1600,DUR=4.0,MAX_BYTES=8*1024*1024;
  var paperTile=null;
  function paintBG(ctx){
    // Fixed neutral paper grain, shared by stills and every animation frame.
    // Paint below the photos and footer so their pixels remain untouched.
    if(!paperTile){
      paperTile=document.createElement('canvas');paperTile.width=paperTile.height=256;
      var g=paperTile.getContext('2d'),d=g.createImageData(256,256),s=88675123;
      for(var i=0;i<d.data.length;i+=4){
        s=(Math.imul(s,1664525)+1013904223)>>>0;
        var v=28+((s>>>16)%7)-3;
        d.data[i]=d.data[i+1]=d.data[i+2]=v;d.data[i+3]=255;
      }
      g.putImageData(d,0,0);
    }
    ctx.fillStyle=ctx.createPattern(paperTile,'repeat')||'#1c1c1c';
    ctx.fillRect(0,0,W,H);
  }
  function fontsReady(){return window.FilmifyPrintDesign.ready();}
  function layout(n,seed){return window.FilmifyPrintDesign.scatter(n,seed===undefined?1:seed);}
  /* aspect fit：完整装入并居中，不裁剪。 */
  function drawCell(ctx,img,cell,alpha){
    var iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;
    var s=Math.min(cell.w/iw,cell.h/ih),dw=iw*s,dh=ih*s;
    ctx.save();
    if(alpha!==undefined)ctx.globalAlpha=alpha;
    ctx.drawImage(img,cell.x+(cell.w-dw)/2,cell.y+(cell.h-dh)/2,dw,dh);
    ctx.restore();
  }
  function drawFooter(ctx,label){
    var D=window.FilmifyPrintDesign,r=D.fitRun(ctx,label||'',26,850),baseline=1519;
    ctx.save();D.draw(ctx,r,80,baseline,D.recipeColors(label||'',true),'left');
    D.brand(ctx,1120,baseline+(r.descent-r.ascent)/2,26);ctx.restore();
  }
  function ease(t){t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);}
  function newCanvas(){
    var canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
    var ctx=canvas.getContext('2d',{alpha:false});
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    return {canvas:canvas,ctx:ctx};
  }
  /* 整幅同步纯渐变显影 painter:返回 draw(ctx,t),t 单位秒 */
  function painter(negs,effs,label,seed){
    var L=layout(effs.length,seed);
    return function(ctx,t){
      paintBG(ctx);
      var na=ease(Math.min(1,t/0.30));
      var rp=0;
      if(t>0.40){var x=Math.min(1,(t-0.40)/2.40);rp=Math.min(1,x*x*(2.2-1.2*x));}
      for(var k=0;k<L.cells.length;k++){
        if(na>0)drawCell(ctx,negs[L.cells[k].index],L.cells[k],na);
        if(rp>0)drawCell(ctx,effs[L.cells[k].index],L.cells[k],rp);
      }
      drawFooter(ctx,label);
    };
  }
  /* 静态拼图(终帧构图) → JPEG Blob;imgs 为已解码小图(ImageBitmap/canvas/Image);
     等署名字体就绪再画,避免脚标闪变/回落字体 */
  function composeStatic(imgs,label,seed){
    return fontsReady().then(function(){
      var L=layout(imgs.length,seed);
      var b=newCanvas(),ctx=b.ctx;
      paintBG(ctx);
      for(var k=0;k<imgs.length;k++)drawCell(ctx,imgs[L.cells[k].index],L.cells[k]);
      drawFooter(ctx,label);
      return new Promise(function(resolve,reject){
        b.canvas.toBlob(function(blob){
          b.canvas.width=b.canvas.height=1;
          if(blob)resolve(blob);else reject(new Error('拼图合成失败'));
        },'image/jpeg',0.92);
      });
    });
  }
  function supported(){
    if(typeof MediaRecorder==='undefined'||typeof MediaRecorder.isTypeSupported!=='function'
      ||typeof HTMLCanvasElement.prototype.captureStream!=='function')return '';
    /* avc1.640028(High Level 4.0)优先,裸 mp4 兜底,42E01E(Baseline L3.0,单帧上限
       3600 宏块 < 1200×1600=7500)最后——与 live-wipe 同序(2026-09-22 真机修复) */
    var types=['video/mp4;codecs=avc1.640028','video/mp4','video/mp4;codecs=avc1.42E01E'];
    for(var i=0;i<types.length;i++){try{if(MediaRecorder.isTypeSupported(types[i]))return types[i];}catch(error){}}
    return '';
  }
  // 黑帧自检(与 live-wipe 同一防线):部分 WebView 声称支持 MP4 却录出全黑,
  // 录完回读中间帧亮度,异常按生成失败处理,由调用方回退纯图片分享。
  function verifyFrames(blob){
    return new Promise(function(resolve){
      var url=URL.createObjectURL(blob);
      var video=document.createElement('video');
      video.muted=true;
      /* 挂到 DOM 再解码回读(与 live-wipe 同理):部分 Android WebView 对未挂载的
         video 不做硬解,drawImage 全黑会被误判成黑帧录制 */
      video.setAttribute('playsinline','');
      video.style.cssText='position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
      document.body.appendChild(video);
      var settled=false,played=false;
      function finish(pass){
        if(settled)return;settled=true;clearTimeout(guard);clearTimeout(stall);
        URL.revokeObjectURL(url);video.removeAttribute('src');
        try{video.load();}catch(error){}
        if(video.parentNode)video.parentNode.removeChild(video);
        resolve(pass);
      }
      /* 读当前帧判黑:全黑=录出黑帧(判失败),否则通过 */
      function probe(){
        try{
          var w=video.videoWidth,h=video.videoHeight;
          if(!w||!h){finish(false);return;}
          var probe=document.createElement('canvas');
          probe.width=64;probe.height=Math.max(1,Math.round(64*h/w));
          var g=probe.getContext('2d');
          g.drawImage(video,0,0,probe.width,probe.height);
          var data=g.getImageData(0,0,probe.width,probe.height).data;
          var sum=0,count=data.length/4;
          for(var i=0;i<data.length;i+=4)sum+=data[i]+data[i+1]+data[i+2];
          probe.width=probe.height=1;
          finish(sum/(count*3)>6);
        }catch(error){finish(false);}
      }
      /* 播放探测兜底(与 live-wipe 同理):iOS Safari 首次解码回读 blob 视频时
         只 seek 不 play 会静默挂起;muted+playsinline 的 play() 是放行路径 */
      function playFallback(){
        if(settled||played)return;played=true;
        video.onseeked=null;
        var p=video.play();
        if(p&&p.catch)p.catch(function(){finish(false);});
      }
      var guard=setTimeout(function(){finish(false);},8000);
      var stall=setTimeout(playFallback,2500);
      video.onerror=function(){finish(false);};
      video.onloadeddata=function(){
        try{video.currentTime=Math.max(0.1,Math.min(1.9,(video.duration||3)/2));}
        catch(error){playFallback();}
      };
      video.onseeked=probe;
      video.ontimeupdate=function(){
        if(!played||settled)return;
        var target=Math.max(0.3,Math.min(1.9,(isFinite(video.duration)?video.duration:3)/2));
        if(video.currentTime>=target){try{video.pause();}catch(error){}probe();}
      };
      video.src=url;
      try{video.load();}catch(error){}
    });
  }
  // 录制 4s 显影动图:negs/effs 为逐格已解码小图(底片/正片同序)。
  // Resolves {cover: JPEG Blob, video: MP4 Blob}; rejects with a user-facing message.
  function record(negs,effs,label,seed){
    var type=supported();
    if(!type)return Promise.reject(new Error('当前环境不支持生成动图，可以选择其它分享方式'));
    if(document.hidden)return Promise.reject(new Error('请保持页面前台生成动图'));
    var b=newCanvas(),canvas=b.canvas,ctx=b.ctx;
    /* 录制期间挂到 DOM(视觉隐藏,CSS 尺寸不影响 captureStream 取原始位图):
       Android Chrome/WebView 对从未挂载的离屏 canvas 抓流有录黑的已知问题 */
    canvas.style.cssText='position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(canvas);
    var draw=painter(negs,effs,label,seed);
    return fontsReady().then(function(){return new Promise(function(resolve,reject){
      var recorder=null,stream=null,raf=0,timeout=0,startGuard=0,start=0,lastDrawT=-1;
      var chunks=[],bytes=0,done=false,stopping=false;
      function cleanup(){
        cancelAnimationFrame(raf);clearTimeout(timeout);
        clearTimeout(startGuard);
        document.removeEventListener('visibilitychange',visibility);
        window.removeEventListener('pagehide',leave);
        if(recorder){
          recorder.onstart=recorder.onstop=recorder.ondataavailable=recorder.onerror=null;
          if(recorder.state!=='inactive'){try{recorder.stop();}catch(error){}}
        }
        if(stream)stream.getTracks().forEach(function(track){track.stop();});
        if(canvas.parentNode)canvas.parentNode.removeChild(canvas);
        canvas.width=canvas.height=1;chunks=[];
      }
      function fail(error){if(done)return;done=true;cleanup();reject(error);}
      function leave(){fail(new Error('动图生成已取消（页面离开前台），可以重试'));}
      function visibility(){if(document.hidden)leave();}
      function step(now){
        if(done||stopping)return;
        try{
          var t=(now-start)/1000;
          /* 流采样率 24fps,按 ~30fps 节流绘制 */
          if(t-lastDrawT>=1/30||t>=DUR){draw(ctx,Math.min(t,DUR));lastDrawT=t;}
          if(t>=DUR){stopping=true;recorder.stop();return;}
          raf=requestAnimationFrame(step);
        }catch(error){fail(error);}
      }
      try{
        draw(ctx,0);
        stream=canvas.captureStream(24);
        recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:4000000});
        recorder.ondataavailable=function(event){
          if(event.data&&event.data.size){
            bytes+=event.data.size;chunks.push(event.data);
            if(bytes>MAX_BYTES)fail(new Error('动图视频过大，请重试'));
          }
        };
        recorder.onerror=function(){fail(new Error('动图录制失败，可以选择其它分享方式'));};
        recorder.onstop=function(){
          if(done)return;
          var actual=recorder.mimeType||type;
          var blob=new Blob(chunks,{type:actual});
          if(blob.size<100){fail(new Error('动图视频没有完整生成，请重试'));return;}
          verifyFrames(blob).then(function(pass){
            if(done)return;
            if(!pass){fail(new Error('动图视频生成异常，可以选择其它分享方式'));return;}
            draw(ctx,DUR); /* 封面 = 终帧(全部正片+脚标) */
            canvas.toBlob(function(coverBlob){
              if(!coverBlob){fail(new Error('动图封面生成失败，请重试'));return;}
              done=true;clearTimeout(timeout);
              var result={cover:coverBlob,video:blob};
              cleanup();
              resolve(result);
            },'image/jpeg',0.94);
          });
        };
        recorder.onstart=function(){start=performance.now();raf=requestAnimationFrame(step);};
        document.addEventListener('visibilitychange',visibility);
        window.addEventListener('pagehide',leave);
        timeout=setTimeout(function(){
          var stage=stopping?'编码器停止无响应':(start?'录制中断':'编码器启动无响应');
          fail(new Error('动图生成超时（'+stage+'），请重试'));
        },12000+DUR*1000);
        /* 启动看门狗(与 live-wipe 同款):mp4 编码管线死锁的 Android WebView 上
           3s 快速判败回退图片分享,不挂 16s */
        startGuard=setTimeout(function(){
          if(!start)fail(new Error('当前设备无法生成动图视频'));
        },3000);
        recorder.start(250);
      }catch(error){fail(error);}
    });},function(error){if(canvas.parentNode)canvas.parentNode.removeChild(canvas);canvas.width=canvas.height=1;throw error;});
  }
  // 页内循环预览(成片页「拼图动图」页):复用同一 painter 循环播放,不录制。
  // negs/effs 在返回的停止函数被调用前必须保持有效。每轮 4s 动画 + 0.8s 停留。
  // 返回停止函数(停循环并释放画布),附 pause/resume(滑离该页挂起 rAF)。
  function preview(negs,effs,label,canvas,seed){
    canvas.width=W;canvas.height=H;
    var ctx=canvas.getContext('2d',{alpha:false});
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    var draw=painter(negs,effs,label,seed);
    var LOOP=DUR+0.8,raf=0,stopped=false,paused=false,held=false,start=performance.now();
    function step(now){
      if(stopped||paused)return;
      try{
        var t=(now-start)/1000%LOOP;
        if(t<DUR){held=false;draw(ctx,t);}
        else if(!held){held=true;draw(ctx,DUR);}
      }catch(error){}
      raf=requestAnimationFrame(step);
    }
    /* 字体就绪后从循环起点开播,避免脚标回落字体闪变(与 live-wipe 同款) */
    fontsReady().then(function(){
      if(stopped||paused)return;
      start=performance.now();draw(ctx,0);
    });
    draw(ctx,0);
    raf=requestAnimationFrame(step);
    var stop=function(){stopped=true;cancelAnimationFrame(raf);canvas.width=canvas.height=1;};
    stop.pause=function(){if(paused||stopped)return;paused=true;cancelAnimationFrame(raf);};
    stop.resume=function(){if(!paused||stopped)return;paused=false;raf=requestAnimationFrame(step);};
    return stop;
  }
  return {layout:layout,paintBackground:paintBG,painter:painter,composeStatic:composeStatic,supported:supported,
    record:record,preview:preview,DUR:DUR,W:W,H:H};
})();
