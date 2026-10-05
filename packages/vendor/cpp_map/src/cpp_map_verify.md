C++ std::map ignores insertion of duplicate keys, it does not even use the new value if you use the `std::map.insert()` method.
```c++
#include <iostream>
#include <map>

struct Key {
    int key;
    int payload;
    Key(int aKey, int aPayload): key(aKey), payload(aPayload){
    }
};

std::ostream& operator<<(std::ostream& os, const Key& k)
{
    return os << "Key: " <<  k.key << ", Payload: " << k.payload;
}

struct cmpByKey {
    bool operator()(const Key& a, const Key& b) const {
        return a.key< b.key;
    }
};

int main(int argc, const char * argv[]) {
    std::map<Key,int, cmpByKey> map;
    map[Key(0,0)] = 0;
    map[Key(1,1)] = 1;
    map[Key(0,2)] = 2; // <- this only replaces value, not key
    
    for( auto it=map.begin(); it != map.end(); it++)
    {
        std::cout <<it->first<<" :: "<<it->second<<std::endl;
    }
    
    map.insert(std::pair<Key,int>(Key(4,4),4));
    map.insert(std::pair<Key,int>(Key(4,5),5)); // <- this is a nop
    for( auto it=map.begin(); it != map.end(); it++)
    {
        std::cout <<it->first<<" :: "<<it->second<<std::endl;
    }
    return 0;
}
```
