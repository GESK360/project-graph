import { describe, expect, test } from "vitest";
import { configureSerializer, deserialize, serializable, serialize } from "../src";

describe("对象序列化", () => {
  class A {
    @serializable
    public propString: string;
    @serializable
    public propNumber: number;
    @serializable
    public propBoolean: boolean;
    @serializable
    public propArray: string[];
    @serializable
    public nestedObject: { name: string; age: number };
    @serializable
    public nestedInstance?: A;

    constructor(
      propString: string,
      propNumber: number,
      propBoolean: boolean,
      propArray: string[],
      nestedObject: { name: string; age: number },
      nestedInstance?: A,
    ) {
      this.propString = propString;
      this.propNumber = propNumber;
      this.propBoolean = propBoolean;
      this.propArray = propArray;
      this.nestedObject = nestedObject;
      this.nestedInstance = nestedInstance;
    }
  }
  const instance = new A(
    "@graphif/serializer",
    114514,
    false,
    ["hello", "world"],
    { name: "Traveller", age: 1000 },
    new A("nested", 123, true, ["nested"], { name: "Trailblazer", age: 2000 }),
  );
  const serialized = {
    _: "A",
    propString: "@graphif/serializer",
    propNumber: 114514,
    propBoolean: false,
    propArray: ["hello", "world"],
    nestedObject: { name: "Traveller", age: 1000 },
    nestedInstance: {
      _: "A",
      propString: "nested",
      propNumber: 123,
      propBoolean: true,
      propArray: ["nested"],
      nestedObject: { name: "Trailblazer", age: 2000 },
    },
  };

  test("序列化对象", () => {
    const serialized = serialize(instance);
    expect(serialized._).toBe("A");
    expect(serialized.nestedInstance._).toBe("A");
    expect(serialized.propString).toBe("@graphif/serializer");
  });
  test("反序列化对象", () => {
    const deserialized = deserialize(serialized);
    expect(deserialized).toBeInstanceOf(A);
    expect(deserialized.nestedInstance).toBeInstanceOf(A);
    expect(deserialized.propString).toBe("@graphif/serializer");
  });

  test("使用稳定类名而不是压缩后的运行时类名", () => {
    class a {
      static className = "StableClass";

      @serializable
      value: string;

      constructor(value: string) {
        this.value = value;
      }
    }

    const serialized = serialize(new a("value"));
    expect(serialized).toEqual({ _: "StableClass", value: "value" });
    expect(deserialize(serialized)).toBeInstanceOf(a);
  });

  test("配置的类名解析器会回退到运行时类名", () => {
    configureSerializer((class_) => class_.className!);

    class C {
      @serializable
      value: string;

      constructor(value: string) {
        this.value = value;
      }
    }

    const serialized = serialize(new C("value"));
    expect(serialized).toEqual({ _: "C", value: "value" });
    expect(deserialize(serialized)).toBeInstanceOf(C);
  });

  // 指针引用同一性的反序列化测试（数组与对象容器）
  class B {
    @serializable
    public items: number[];
    @serializable
    public meta: { tag: string; count: number };
    @serializable
    public mirrorItems?: number[];
    @serializable
    public mirrorMeta?: { tag: string; count: number };

    constructor(
      items: number[],
      meta: { tag: string; count: number },
      mirrorItems?: number[],
      mirrorMeta?: { tag: string; count: number },
    ) {
      this.items = items;
      this.meta = meta;
      this.mirrorItems = mirrorItems;
      this.mirrorMeta = mirrorMeta;
    }
  }

  test("反序列化时，数组与对象容器通过指针保持同一实例", () => {
    const json = {
      _: "B",
      items: [1, 2, 3],
      meta: { tag: "t", count: 2 },
      mirrorItems: { $: "/items" },
      mirrorMeta: { $: "/meta" },
    };
    const b = deserialize(json) as B;

    expect(b).toBeInstanceOf(B);
    expect(Array.isArray(b.items)).toBe(true);
    expect(Array.isArray(b.mirrorItems)).toBe(true);
    expect(b.items).toBe(b.mirrorItems);

    expect(typeof b.meta).toBe("object");
    expect(b.meta).toBe(b.mirrorMeta);
  });

  test("反序列化非 passObject 类时按 @serializable 声明顺序传参，不受 JSON 键顺序影响", () => {
    class RgbaLike {
      @serializable
      public r: number;
      @serializable
      public g: number;
      @serializable
      public b: number;
      @serializable
      public a: number;

      constructor(r: number, g: number, b: number, a: number = 1) {
        this.r = r;
        this.g = g;
        this.b = b;
        this.a = a;
      }
    }

    // 模拟 Rust serde_json::Value(BTreeMap) 按字母序重排后的 JSON 对象
    const alphabeticallySorted = {
      _: "RgbaLike",
      a: 1,
      b: 235,
      g: 99,
      r: 37,
    };
    const restored = deserialize(alphabeticallySorted) as RgbaLike;
    expect(restored).toBeInstanceOf(RgbaLike);
    expect(restored.r).toBe(37);
    expect(restored.g).toBe(99);
    expect(restored.b).toBe(235);
    expect(restored.a).toBe(1);

    // 缺失尾部可选字段且混入未知字段时，不破坏默认参数
    const withDefaultAndExtra = {
      _: "RgbaLike",
      b: 68,
      extraLegacyKey: 999,
      g: 68,
      r: 239,
    };
    const restoredDefault = deserialize(withDefaultAndExtra) as RgbaLike;
    expect(restoredDefault.r).toBe(239);
    expect(restoredDefault.g).toBe(68);
    expect(restoredDefault.b).toBe(68);
    expect(restoredDefault.a).toBe(1);
  });
});

describe("数组序列化", () => {
  const arr = [1, "2", true, { name: "Traveller", age: 1000 }, [1, 2, 3]];
  const serialized = [1, "2", true, { name: "Traveller", age: 1000 }, [1, 2, 3]];

  test("序列化数组", () => {
    const serialized = serialize(arr);
    expect(serialized).toEqual(serialized);
  });
  test("反序列化数组", () => {
    const deserialized = deserialize(serialized);
    expect(deserialized).toEqual(arr);
  });
});
