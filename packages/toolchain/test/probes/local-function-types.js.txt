function outer(){ const f = function(x){ return x*2 }; const g = (y)=>f(y)+1; return g(5) }
console.log(outer());
function a(){ var h = function(){ return "a" }; return h() } function b(){ var h = function(){ return 2 }; return h()+1 } console.log(a(), b());
