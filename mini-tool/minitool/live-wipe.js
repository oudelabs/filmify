'use strict';
// 4s darkroom-fog live photo (single-photo single-recipe share group + result-page
// in-app loop): 负片亮相 → 沉入雾色 → 成片浮现 → 停留,末帧=封面。
// 单图装裱共用已确认的白卡/黑卡布局，配方左、原版 Logo 右，全程常显。
// Canvas2D + MediaRecorder only; no camera/mic/network.
window.FilmifyLiveWipe=(function(){
  var DURATION=4.0,MAX_BYTES=8*1024*1024;
  /* 时间轴(定稿):负片 0–0.40s | 沉雾 0.40–1.10s | 浮现 1.10–2.80s | 停留至 4s */
  var T={hold:0.40,dev0:1.10,dev1:2.80};
  var FOG='#2f1d12';
  function supported(){
    if(typeof MediaRecorder==='undefined'||typeof MediaRecorder.isTypeSupported!=='function'
      ||typeof HTMLCanvasElement.prototype.captureStream!=='function')return '';
    /* avc1.640028(High Level 4.0,单帧上限 8192 宏块,装得下 1280 长边画面)优先:
       原首选 avc1.42E01E=Baseline L3.0 单帧上限 3600 宏块,与录制画面尺寸不匹配,
       桌面软编不理会,Android 硬编(MediaCodec 按 profile/level 配)会失败/录黑;
       裸 mp4 兜底(桌面 Chrome 可能给 VP9-in-MP4,故排第二),42E01E 最后
       (2026-09-22 真机修复) */
    var types=['video/mp4;codecs=avc1.640028','video/mp4','video/mp4;codecs=avc1.42E01E'];
    for(var i=0;i<types.length;i++){try{if(MediaRecorder.isTypeSupported(types[i]))return types[i];}catch(error){}}
    return '';
  }
  var clamp=function(x){return Math.max(0,Math.min(1,x));};
  var ease=function(x){x=clamp(x);return x*x*(3-2*x);};
  function fontsReady(){return window.FilmifyPrintDesign.ready();}
  // 黑帧自检(2026-09-21):部分 WebView 的 MediaRecorder 声称支持 MP4 却录出全黑画面,
  // 直接分享会在发布页出现黑图。录完把视频解码回读中间帧亮度,异常则视为生成失败,
  // 由调用方回退纯图片分享组。解码/seek 失败同样按不通过处理(宁可不带实况,不发黑图)。
  function verifyFrames(blob){
    return new Promise(function(resolve){
      var url=URL.createObjectURL(blob);
      var video=document.createElement('video');
      video.muted=true;
      /* 挂到 DOM 再解码回读(2026-09-22 真机修复):部分 Android WebView 对未挂载的
         video 元素不做硬件解码,drawImage 读出全黑会被误判成黑帧录制 */
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
      /* 播放探测兜底(2026-09-22 iOS 真机实锤):Safari 首次解码回读 blob 视频时
         只 seek 不 play 会静默挂起(录成功却 8s 无 seeked 被误判失败,重试即好);
         muted+playsinline 的 play() 是放行路径,播到中点暂停读帧 */
      function playFallback(){
        if(settled||played)return;played=true;
        video.onseeked=null;
        var p=video.play();
        if(p&&p.catch)p.catch(function(){finish(false);});
      }
      var guard=setTimeout(function(){finish(false);},8000);
      /* 无论卡在 load 还是 seek,2.5s 没进展就转播放探测 */
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
  function cover(g,img,x,y,w,h){
    var width=img.naturalWidth||img.width,height=img.naturalHeight||img.height;
    var s=Math.max(w/width,h/height);
    var iw=width*s,ih=height*s;
    g.save();g.beginPath();g.rect(x,y,w,h);g.clip();
    g.drawImage(img,x+(w-iw)/2,y+(h-ih)/2,iw,ih);g.restore();
  }
  function layout(effect){return window.FilmifyPrintDesign.matLayout(effect.naturalWidth||effect.width,effect.naturalHeight||effect.height,true);}
  function painter(negative,effect,opts,W,H){
    var D=window.FilmifyPrintDesign,L=layout(effect);
    return function(ctx,t){
      ctx.save();ctx.scale(W/L.W,H/L.H);D.matBase(ctx,L,opts.theme==='black');
      var x=L.x,y=L.y,w=L.cw,h=L.ch;
      ctx.fillStyle=FOG;ctx.fillRect(x,y,w,h);
      var na=1-ease((t-T.hold)/(T.dev0-T.hold));
      if(na>0){ctx.save();ctx.globalAlpha=na;cover(ctx,negative,x,y,w,h);ctx.restore();}
      var q=clamp((t-T.dev0)/(T.dev1-T.dev0)),dp=q*q*(2.2-1.2*q);
      if(dp>0){ctx.save();ctx.globalAlpha=Math.min(1,dp);cover(ctx,effect,x,y,w,h);ctx.restore();}
      D.matFooter(ctx,L,opts,true);ctx.restore();
    };
  }
  // negative/effect: loaded Image elements; opts: {film,paper,theme}。
  // Resolves {cover: JPEG Blob, video: MP4 Blob}; rejects with a user-facing message.
  function record(negative,effect,opts){
    var type=supported();
    if(!type)return Promise.reject(new Error('当前环境不支持生成实况，可以选择其它分享方式'));
    if(document.hidden)return Promise.reject(new Error('请保持页面前台生成实况'));
    var L=layout(effect);
    var W=L.W,H=L.H;
    var canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
    /* 录制期间挂到 DOM(视觉隐藏,CSS 尺寸不影响 captureStream 取画布原始位图):
       Android Chrome/WebView 对从未挂载的离屏 canvas 抓流有录出黑帧的已知问题
       (2026-09-22 真机修复) */
    canvas.style.cssText='position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(canvas);
    var ctx=canvas.getContext('2d',{alpha:false});
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    var draw=painter(negative,effect,opts,W,H);
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
      function leave(){fail(new Error('实况生成已取消（页面离开前台），可以重试'));}
      function visibility(){if(document.hidden)leave();}
      function step(now){
        if(done||stopping)return;
        try{
          var t=(now-start)/1000;
          /* 流采样率 24fps,按 ~30fps 节流绘制:高刷新率屏幕上 rAF 可达 120Hz,
             超出部分全是无效重绘(2026-09-21 性能审查) */
          if(t-lastDrawT>=1/30||t>=DURATION){draw(ctx,Math.min(t,DURATION));lastDrawT=t;}
          if(t>=DURATION){stopping=true;recorder.stop();return;}
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
            if(bytes>MAX_BYTES)fail(new Error('实况视频过大，请重试'));
          }
        };
        recorder.onerror=function(){fail(new Error('实况录制失败，可以选择其它分享方式'));};
        recorder.onstop=function(){
          if(done)return;
          var actual=recorder.mimeType||type;
          var blob=new Blob(chunks,{type:actual});
          if(blob.size<100){fail(new Error('实况视频没有完整生成，请重试'));return;}
          /* 黑帧自检通过才交付实况,否则按生成失败回退纯图片分享 */
          verifyFrames(blob).then(function(pass){
            if(done)return;
            if(!pass){fail(new Error('实况视频生成异常，可以选择其它分享方式'));return;}
            draw(ctx,DURATION); // 封面 = 末尾装裱完成帧
            canvas.toBlob(function(coverBlob){
              if(!coverBlob){fail(new Error('实况封面生成失败，请重试'));return;}
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
          /* 带上卡住阶段便于真机定位:start=0 说明 onstart 未触发;
             stopping 说明 stop() 后 onstop 未回来(编码器死锁) */
          var stage=stopping?'编码器停止无响应':(start?'录制中断':'编码器启动无响应');
          fail(new Error('实况生成超时（'+stage+'），请重试'));
        },12000+DURATION*1000);
        /* 启动看门狗(2026-09-22 真机修复):小米浏览器 WebView 等部分 Android 内核
           mp4 录制管线死锁——start() 后 onstart/onerror 均不派发、零数据,
           只能等超时;3s 未见 onstart 直接判败,快速回退图片分享 */
        startGuard=setTimeout(function(){
          if(!start)fail(new Error('当前设备无法生成实况视频'));
        },3000);
        recorder.start(250);
      }catch(error){fail(error);}
    });},function(error){if(canvas.parentNode)canvas.parentNode.removeChild(canvas);canvas.width=canvas.height=1;throw error;});
  }
  // 页内循环预览(成片页「动图」页):复用同一 painter 循环播放(含装裱与署名),
  // 不录制、不依赖 MediaRecorder。negative/effect 为已加载 Image,调用方须保证两者
  // 在返回的停止函数被调用前保持有效(不要清 src)。每轮 4s 动画 + 0.8s 停留。
  // 页面隐藏时 rAF 自动暂停;返回停止函数(停循环并释放画布)。
  function preview(negative,effect,opts,canvas){
    var L=layout(effect);
    canvas.width=L.W;canvas.height=L.H;
    var ctx=canvas.getContext('2d',{alpha:false});
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    var draw=painter(negative,effect,opts,L.W,L.H);
    var LOOP=DURATION+0.8,raf=0,stopped=false,paused=false,held=false,start=performance.now();
    function step(now){
      if(stopped||paused)return;
      try{
        var t=(now-start)/1000%LOOP;
        /* 每轮末尾 0.8s 停留段画面静止:画一次最终帧后跳过重绘(性能审查) */
        if(t<DURATION){held=false;draw(ctx,t);}
        else if(!held){held=true;draw(ctx,DURATION);}
      }catch(error){}
      raf=requestAnimationFrame(step);
    }
    /* 字体就绪后从循环起点开播,避免首帧回落字体闪变 */
    fontsReady().then(function(){
      if(stopped||paused)return;
      start=performance.now();draw(ctx,0);
    });
    draw(ctx,0);
    raf=requestAnimationFrame(step);
    /* 返回停止函数(停循环并释放画布),附 pause/resume:滑离动图页时挂起 rAF(画布内容
       保留),滑回后续播(2026-09-21 性能审查) */
    var stop=function(){stopped=true;cancelAnimationFrame(raf);canvas.width=canvas.height=1;};
    stop.pause=function(){if(paused||stopped)return;paused=true;cancelAnimationFrame(raf);};
    stop.resume=function(){if(!paused||stopped)return;paused=false;raf=requestAnimationFrame(step);};
    return stop;
  }
  return {supported:supported,record:record,preview:preview,layout:layout,painter:painter,DURATION:DURATION};
})();
