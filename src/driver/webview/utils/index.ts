import { isNil } from 'lodash';

// Check if the value is unset (null, undefined, or empty string)
export const isUnset = (value: unknown) => isNil(value) || value === '';

// Create a selfish proxy for an object
export function selfish<T extends object>(target: T) {
    // Initialize a WeakMap to store bound functions
    const cache = new WeakMap();

    // Create a Proxy for the target object
    return new Proxy(target, {
        get(target, key) {
            // Get the value of the target key
            const value = Reflect.get(target, key);

            // Return the value if it's not a function
            if (typeof value !== 'function') {
                return value;
            }

            // Bind the function to the target object if not already cached
            if (!cache.has(value)) {
                cache.set(value, value.bind(target));
            }

            // Return the cached bound function
            return cache.get(value);
        },
    }) as T;
}