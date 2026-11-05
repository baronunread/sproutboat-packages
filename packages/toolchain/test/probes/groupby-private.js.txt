console.log(JSON.stringify(Map.groupBy([1,2,3],x=>x%2).get(1))); class A{ #p=1; static h(o){return #p in o} } console.log(A.h(new A()));
