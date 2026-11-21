import {rectInsideCircle,type QrRect} from '@podjs/framework/round-layout';

export function speechControlsLayout(width:number,height:number,errorLines:number,round:boolean) {
  const squareTop=85+(errorLines?5+errorLines*14:0);
  const inner=width-36,gap=Math.max(0,(inner-184)/5);
  const rect=(x:number,y:number,width:number,height:number):QrRect=>({x,y,width,height});
  const square=()=>{
    const rateTop=squareTop+67;
    return {
      previous:rect(18+gap,squareTop+8,42,42),
      toggle:rect(60+gap*2,squareTop,58,58),
      next:rect(118+gap*3,squareTop+8,42,42),
      stop:rect(160+gap*4,squareTop+8,42,42),
      auto:rect(18,rateTop,Math.max(36,inner-116),36),
      slower:rect(width-124,rateTop+2,32,32),
      rate:rect(width-92,rateTop+7,42,22),
      faster:rect(width-50,rateTop+2,32,32),
      return:rect(18,squareTop+111,inner,34),
    };
  };
  if(!round)return {headerScale:1,headerTop:0,buttons:square()};

  const diameter=Math.min(width,height),scale=diameter/233;
  const left=(width-diameter)/2,top=(height-diameter)/2;
  const place=(x:number,y:number,w:number,h:number)=>rect(left+x*scale,top+y*scale,w*scale,h*scale);
  const main=errorLines?86+errorLines*14:85,rate=main+51;
  const buttons={
    previous:place(31,main+6,38,38),
    toggle:place(72,main,50,50),
    next:place(125,main+6,38,38),
    stop:place(165,main+6,38,38),
    auto:place(48.5,rate,38,32),
    slower:place(86.5,rate,32,32),
    rate:place(118.5,rate+5,34,22),
    faster:place(152.5,rate,32,32),
    return:place(68.5,rate+34,96,20),
  };
  const circle={cx:width/2,cy:height/2,radius:diameter/2};
  const inside=Object.values(buttons).every(box=>rectInsideCircle(box,circle,Math.min(scale*2,2)));
  // Invalid viewport metrics must not create hit targets outside the display.
  return {headerScale:scale,headerTop:top,buttons:inside?buttons:undefined};
}
